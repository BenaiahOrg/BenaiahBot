import { api, db, BotApiError } from 'sdk';
import { and, asc, desc, eq, inArray, isNotNull, lt, sql } from 'sdk/db';
import { cache, counselors, offers, queued, requests, users } from '../schema.js';
import { OFFER_TIMEOUT_MS } from './constants.js';
import { allTranslations, t } from './i18n.js';
import { button, editHtml, keyboard, react, sendHtml, show } from './ui.js';
import { counselorByUser } from './users.js';
import { mainMenu } from './views.js';

// Anonymous counseling. A request is offered to one random free counselor at a
// time; declining or not answering within OFFER_TIMEOUT_MS passes it on. While
// a session is active, messages are relayed with copyMessage, which carries no
// trace of the sender, so neither side learns who the other is. Message text is
// never stored. Before anyone is notified the person writes a first message,
// which is copied above each offer so counselors can decide.

const OPEN = ['intro', 'searching', 'waiting', 'active'];
const UNASSIGNED = ['searching', 'waiting'];
const CANCELLABLE = ['intro', ...UNASSIGNED];
// A counselor who let an offer expire may get the same request again after this.
const RETRY_AFTER_MS = 2 * OFFER_TIMEOUT_MS;
const DRAIN_EVERY_MS = 60 * 1000;

const END_TEXTS = allTranslations('endSession');

export function isEndButton(text) {
  return END_TEXTS.includes(String(text || '').trim());
}

function endKeyboard(lang) {
  return { keyboard: [[{ text: t(lang, 'endSession') }]], resize_keyboard: true, is_persistent: true };
}

const REMOVE_KEYBOARD = { remove_keyboard: true };

async function langOf(userId) {
  const row = await db.select({ lang: users.lang }).from(users).where(eq(users.id, userId)).get();
  return row?.lang || 'en';
}

function isGone(error) {
  return error instanceof BotApiError && (error.code === 403 || /chat not found|user is deactivated/i.test(error.description || ''));
}

export async function openRequestForUser(userId) {
  return db.select().from(requests)
    .where(and(eq(requests.userId, userId), inArray(requests.status, OPEN)))
    .orderBy(desc(requests.id))
    .get();
}

export async function activeRequestForCounselor(counselorId) {
  return db.select().from(requests)
    .where(and(eq(requests.counselorId, counselorId), eq(requests.status, 'active')))
    .get();
}

async function busyCounselorIds() {
  const rows = await db.all(sql`
    SELECT counselor_id AS id FROM requests WHERE status = 'active' AND counselor_id IS NOT NULL
    UNION SELECT counselor_id AS id FROM offers WHERE status = 'pending'`);
  return new Set(rows.map((row) => row.id));
}

// Counselors who may be offered this request now, preferring ones it has never
// been offered to.
async function candidatesFor(request) {
  const pool = await db.select().from(counselors)
    .where(and(eq(counselors.active, 1), eq(counselors.removed, 0), isNotNull(counselors.userId)))
    .all();
  const busy = await busyCounselorIds();
  const history = await db.select().from(offers).where(eq(offers.requestId, request.id)).all();
  const now = Date.now();
  const free = pool.filter((c) => c.userId !== request.userId && !busy.has(c.id));
  const fresh = free.filter((c) => !history.some((o) => o.counselorId === c.id));
  if (fresh.length) return fresh;
  // Everyone free has seen it. Retry those who only let it expire, after a pause.
  return free.filter((c) => {
    const mine = history.filter((o) => o.counselorId === c.id);
    return mine.every((o) => o.status === 'expired' && now - (o.respondedAt || 0) > RETRY_AFTER_MS);
  });
}

function offerText(lang, request, hasIntro = false) {
  return t(lang, 'offer', request.id, t(request.lang, 'langName'), hasIntro);
}

// Copies the person's first message to a counselor; returns the copy's id, or
// null when it is gone (the person deleted it).
async function copyIntro(request, chatId) {
  if (!request.introMessageId) return null;
  try {
    const copy = await api.copyMessage({ chat_id: chatId, from_chat_id: request.userId, message_id: request.introMessageId });
    return copy.message_id;
  } catch (error) {
    if (!(error instanceof BotApiError) || isGone(error)) throw error;
    return null;
  }
}

// Offers an unassigned request to a random free counselor. Returns the
// request's resulting status ('searching' when offered, 'waiting' when queued).
export async function dispatch(requestId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const request = await db.select().from(requests).where(eq(requests.id, requestId)).get();
    if (!request || !UNASSIGNED.includes(request.status)) return request?.status ?? null;
    const pending = await db.select().from(offers)
      .where(and(eq(offers.requestId, requestId), eq(offers.status, 'pending')))
      .get();
    if (pending) return 'searching';

    const candidates = await candidatesFor(request);
    if (!candidates.length) {
      if (request.status !== 'waiting') {
        await db.update(requests).set({ status: 'waiting' }).where(eq(requests.id, requestId)).run();
      }
      return 'waiting';
    }

    const counselor = candidates[Math.floor(Math.random() * candidates.length)];
    const [offer] = await db.insert(offers).values({
      requestId,
      counselorId: counselor.id,
      status: 'pending',
      createdAt: Date.now(),
    }).returning();
    const lang = await langOf(counselor.userId);
    try {
      const introId = await copyIntro(request, counselor.userId);
      const sent = await api.sendMessage({
        chat_id: counselor.userId,
        text: offerText(lang, request, Boolean(introId)),
        parse_mode: 'HTML',
        reply_parameters: introId ? { message_id: introId, allow_sending_without_reply: true } : undefined,
        reply_markup: keyboard([[
          button(t(lang, 'accept'), `o+:${offer.id}`, 'success'),
          button(t(lang, 'decline'), `o-:${offer.id}`, 'danger'),
        ]]),
      });
      await db.update(offers).set({ messageId: sent.message_id }).where(eq(offers.id, offer.id)).run();
      if (request.status !== 'searching') {
        await db.update(requests).set({ status: 'searching' }).where(eq(requests.id, requestId)).run();
      }
      return 'searching';
    } catch (error) {
      if (!(error instanceof BotApiError)) throw error;
      // The counselor hasn't opened the bot or has blocked it.
      await db.update(offers).set({ status: 'failed', respondedAt: Date.now() }).where(eq(offers.id, offer.id)).run();
    }
  }
  return 'waiting';
}

// Gives queued requests, oldest first, to counselors who became free.
export async function drainQueue() {
  const waiting = await db.select({ id: requests.id }).from(requests)
    .where(eq(requests.status, 'waiting'))
    .orderBy(asc(requests.createdAt))
    .limit(20)
    .all();
  // Being offered again is invisible to the person; they were already told to wait.
  for (const { id } of waiting) await dispatch(id);
}

// Runs on every update: expires unanswered offers and, at most once a minute,
// retries the queue. There is no scheduler on the platform, so traffic is the clock.
export async function sweep() {
  const cutoff = Date.now() - OFFER_TIMEOUT_MS;
  const stale = await db.select().from(offers)
    .where(and(eq(offers.status, 'pending'), lt(offers.createdAt, cutoff)))
    .limit(20)
    .all();
  for (const offer of stale) {
    const changed = await db.update(offers)
      .set({ status: 'expired', respondedAt: Date.now() })
      .where(and(eq(offers.id, offer.id), eq(offers.status, 'pending')))
      .returning({ id: offers.id });
    if (!changed.length) continue;
    const counselor = await db.select().from(counselors).where(eq(counselors.id, offer.counselorId)).get();
    if (counselor?.userId) {
      await editHtml(counselor.userId, offer.messageId, t(await langOf(counselor.userId), 'offerExpired', offer.requestId));
    }
    await reassign(offer.requestId);
  }
  if (stale.length || await drainDue()) await drainQueue();
}

async function drainDue() {
  const any = await db.get(sql`SELECT 1 AS one FROM requests WHERE status = 'waiting' LIMIT 1`);
  if (!any) return false;
  const key = 'drain:last';
  const row = await db.select().from(cache).where(eq(cache.key, key)).get();
  const now = Date.now();
  if (row && now - row.fetchedAt < DRAIN_EVERY_MS) return false;
  await db.insert(cache).values({ key, fetchedAt: now, payload: {} })
    .onConflictDoUpdate({ target: cache.key, set: { fetchedAt: now } })
    .run();
  return true;
}

// Passes a request on after a decline or expiry, telling the person when it
// had to join the queue.
async function reassign(requestId) {
  const before = await db.select().from(requests).where(eq(requests.id, requestId)).get();
  const status = await dispatch(requestId);
  if (before?.status === 'searching' && status === 'waiting') {
    await sendHtml(before.userId, t(before.lang, 'counselWaiting'), cancelKeyboard(before.lang, requestId));
  }
}

function cancelKeyboard(lang, requestId) {
  return keyboard([[button(t(lang, 'counselCancel'), `C-:${requestId}`, 'danger')]]);
}

export function introView(lang) {
  return {
    html: t(lang, 'counselIntro'),
    keyboard: keyboard([
      [button(t(lang, 'counselStart'), 'C+', 'success')],
      [button(t(lang, 'home'), 'M')],
    ]),
  };
}

export async function requestCounseling(user, lang) {
  const counselor = await counselorByUser(user.id);
  if (counselor && await activeRequestForCounselor(counselor.id)) {
    return sendHtml(user.id, t(lang, 'counselOpen'));
  }
  const open = await openRequestForUser(user.id);
  if (open) {
    const markup = open.status === 'active' ? endKeyboard(lang) : cancelKeyboard(lang, open.id);
    return sendHtml(user.id, t(lang, 'counselOpen'), markup);
  }
  // Nobody is notified until the person's first message arrives (routeMessage).
  const [request] = await db.insert(requests).values({
    userId: user.id,
    lang,
    status: 'intro',
    createdAt: Date.now(),
  }).returning();
  return sendHtml(user.id, t(lang, 'counselAskIntro'), cancelKeyboard(lang, request.id));
}

async function submitIntro(message, request) {
  const started = await db.update(requests)
    .set({ status: 'searching', introMessageId: message.message_id, userMessages: 1 })
    .where(and(eq(requests.id, request.id), eq(requests.status, 'intro')))
    .returning({ id: requests.id });
  if (!started.length) return;
  const status = await dispatch(request.id);
  await sendHtml(message.chat.id, t(request.lang, status === 'searching' ? 'counselSearching' : 'counselWaiting'), cancelKeyboard(request.lang, request.id));
}

async function cancelPendingOffers(requestId) {
  const pending = await db.select().from(offers)
    .where(and(eq(offers.requestId, requestId), eq(offers.status, 'pending')))
    .all();
  for (const offer of pending) {
    await db.update(offers).set({ status: 'cancelled', respondedAt: Date.now() }).where(eq(offers.id, offer.id)).run();
    const counselor = await db.select().from(counselors).where(eq(counselors.id, offer.counselorId)).get();
    if (counselor?.userId) await editHtml(counselor.userId, offer.messageId, t(await langOf(counselor.userId), 'offerGone', requestId));
  }
}

export async function cancelRequest(userId, requestId) {
  const changed = await db.update(requests)
    .set({ status: 'cancelled', endedAt: Date.now(), endedBy: 'user' })
    .where(and(eq(requests.id, requestId), eq(requests.userId, userId), inArray(requests.status, CANCELLABLE)))
    .returning({ id: requests.id });
  if (!changed.length) return false;
  await cancelPendingOffers(requestId);
  await db.delete(queued).where(eq(queued.requestId, requestId)).run();
  await drainQueue();
  return true;
}

// Returns a short text for the callback answer.
export async function acceptOffer(from, offerId) {
  const offer = await db.select().from(offers).where(eq(offers.id, offerId)).get();
  const counselor = offer && await db.select().from(counselors).where(eq(counselors.id, offer.counselorId)).get();
  const lang = await langOf(from.id);
  if (!offer || counselor?.userId !== from.id) return t(lang, 'offerGone', offer?.requestId ?? '');
  const claimed = await db.update(offers)
    .set({ status: 'accepted', respondedAt: Date.now() })
    .where(and(eq(offers.id, offerId), eq(offers.status, 'pending')))
    .returning({ id: offers.id });
  if (!claimed.length) {
    const key = offer.status === 'expired' ? 'offerExpired' : 'offerGone';
    await editHtml(from.id, offer.messageId, t(lang, key, offer.requestId));
    return t(lang, key, offer.requestId);
  }
  const now = Date.now();
  const assigned = await db.update(requests)
    .set({ status: 'active', counselorId: counselor.id, acceptedAt: now })
    .where(and(eq(requests.id, offer.requestId), inArray(requests.status, UNASSIGNED)))
    .returning();
  if (!assigned.length) {
    await db.update(offers).set({ status: 'cancelled' }).where(eq(offers.id, offerId)).run();
    await editHtml(from.id, offer.messageId, t(lang, 'offerGone', offer.requestId));
    return t(lang, 'offerGone', offer.requestId);
  }
  const request = assigned[0];
  await editHtml(from.id, offer.messageId, `${offerText(lang, request).split('\n')[0]}\n${t(lang, 'accept')}`);
  await sendHtml(from.id, t(lang, 'offerAccepted', request.id), endKeyboard(lang));

  const waiting = await db.select().from(queued).where(eq(queued.requestId, request.id)).orderBy(asc(queued.messageId)).all();
  if (waiting.length) {
    await sendHtml(from.id, `<i>${t(lang, 'queuedHeader')}</i>`);
    const ids = waiting.map((row) => row.messageId);
    for (let i = 0; i < ids.length; i += 100) {
      try {
        await api.copyMessages({ chat_id: from.id, from_chat_id: request.userId, message_ids: ids.slice(i, i + 100) });
      } catch (error) {
        if (!(error instanceof BotApiError)) throw error;
      }
    }
    await db.update(requests).set({ userMessages: request.userMessages + ids.length }).where(eq(requests.id, request.id)).run();
    await db.delete(queued).where(eq(queued.requestId, request.id)).run();
  }
  try {
    await sendHtml(request.userId, t(request.lang, 'counselConnected'), endKeyboard(request.lang));
  } catch (error) {
    if (!isGone(error)) throw error;
    await endSession(request.id, 'system');
  }
  return t(lang, 'accept');
}

export async function declineOffer(from, offerId) {
  const offer = await db.select().from(offers).where(eq(offers.id, offerId)).get();
  const counselor = offer && await db.select().from(counselors).where(eq(counselors.id, offer.counselorId)).get();
  const lang = await langOf(from.id);
  if (!offer || counselor?.userId !== from.id) return t(lang, 'offerGone', offer?.requestId ?? '');
  const changed = await db.update(offers)
    .set({ status: 'declined', respondedAt: Date.now() })
    .where(and(eq(offers.id, offerId), eq(offers.status, 'pending')))
    .returning({ id: offers.id });
  if (!changed.length) {
    await editHtml(from.id, offer.messageId, t(lang, 'offerGone', offer.requestId));
    return t(lang, 'offerGone', offer.requestId);
  }
  await editHtml(from.id, offer.messageId, t(lang, 'offerDeclined', offer.requestId));
  await reassign(offer.requestId);
  await drainQueue();
  return t(lang, 'decline');
}

// by: 'user' | 'counselor' | 'admin' | 'system'
export async function endSession(requestId, by) {
  const ended = await db.update(requests)
    .set({ status: 'ended', endedAt: Date.now(), endedBy: by })
    .where(and(eq(requests.id, requestId), eq(requests.status, 'active')))
    .returning();
  if (!ended.length) return false;
  const request = ended[0];
  const counselor = await db.select().from(counselors).where(eq(counselors.id, request.counselorId)).get();

  // The reply keyboard can only be removed by a message of its own, so each
  // side gets the notice, then the main menu (with the rating for the person).
  const userKey = by === 'user' ? 'endedByUser' : by === 'counselor' ? 'endedByCounselor' : 'endedBySystem';
  try {
    await sendHtml(request.userId, t(request.lang, userKey), REMOVE_KEYBOARD);
    await show(request.userId, null, by === 'user' || by === 'counselor' ? menuWithRating(request) : mainMenu(request.lang));
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  if (counselor?.userId) {
    const lang = await langOf(counselor.userId);
    const key = by === 'user' ? 'userEnded' : by === 'counselor' ? 'counselorEnded' : 'systemEnded';
    try {
      await sendHtml(counselor.userId, t(lang, key, request.id), REMOVE_KEYBOARD);
      await show(counselor.userId, null, mainMenu(lang));
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  await drainQueue();
  return true;
}

// The main menu with a row of stars on top.
function menuWithRating(request) {
  const menu = mainMenu(request.lang, `<b>${t(request.lang, 'ratePrompt')}</b>`);
  const stars = [1, 2, 3, 4, 5].map((n) => button(`${n}⭐`, `r:${request.id}:${n}`));
  return { ...menu, keyboard: { inline_keyboard: [stars, ...menu.keyboard.inline_keyboard] } };
}

export async function rate(userId, requestId, stars) {
  const n = Math.min(5, Math.max(1, Math.round(stars)));
  await db.update(requests)
    .set({ rating: n })
    .where(and(eq(requests.id, requestId), eq(requests.userId, userId), eq(requests.status, 'ended')))
    .run();
}

// Routes a message that belongs to a counseling conversation. Returns true when
// the message was handled here.
export async function routeMessage(message, user) {
  const counselor = await counselorByUser(user.id);
  if (counselor) {
    const session = await activeRequestForCounselor(counselor.id);
    if (session) {
      if (isEndButton(message.text) || /^\/end\b/.test(message.text || '')) {
        await endSession(session.id, 'counselor');
        return true;
      }
      if (message.text?.startsWith('/')) return false;
      await relay(message, session, session.userId, 'counselorMessages', 'counselor');
      return true;
    }
  }

  const open = await openRequestForUser(user.id);
  if (!open) return false;
  if (open.status === 'intro') {
    if (message.text?.startsWith('/')) return false;
    await submitIntro(message, open);
    return true;
  }
  if (open.status === 'active') {
    if (isEndButton(message.text) || /^\/end\b/.test(message.text || '')) {
      await endSession(open.id, 'user');
      return true;
    }
    if (message.text?.startsWith('/')) return false;
    const target = await db.select().from(counselors).where(eq(counselors.id, open.counselorId)).get();
    if (!target?.userId) {
      await endSession(open.id, 'system');
      return true;
    }
    await relay(message, open, target.userId, 'userMessages', 'user');
    return true;
  }
  // Still looking for a counselor: keep the message to deliver on accept.
  if (message.text?.startsWith('/')) return false;
  await db.insert(queued).values({ requestId: open.id, messageId: message.message_id }).run();
  await react(message.chat.id, message.message_id, '👌');
  return true;
}

async function relay(message, request, targetChatId, counter, side) {
  try {
    await api.copyMessage({ chat_id: targetChatId, from_chat_id: message.chat.id, message_id: message.message_id });
    const column = counter === 'userMessages' ? requests.userMessages : requests.counselorMessages;
    await db.update(requests).set({ [counter]: sql`${column} + 1` }).where(eq(requests.id, request.id)).run();
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    const lang = side === 'user' ? request.lang : await langOf(message.chat.id);
    if (isGone(error)) {
      await sendHtml(message.chat.id, t(lang, 'relayFailed'));
      await endSession(request.id, 'system');
    } else {
      // Some message kinds (e.g. polls, dice) can't be copied.
      await react(message.chat.id, message.message_id, '🤷');
    }
  }
}

// Called when someone blocks the bot.
export async function userLeft(userId) {
  const open = await openRequestForUser(userId);
  if (open?.status === 'active') await endSession(open.id, 'system');
  else if (open) {
    await db.update(requests).set({ status: 'cancelled', endedAt: Date.now(), endedBy: 'system' }).where(eq(requests.id, open.id)).run();
    await cancelPendingOffers(open.id);
  }
  const counselor = await counselorByUser(userId);
  if (counselor) {
    await db.update(counselors).set({ active: 0 }).where(eq(counselors.id, counselor.id)).run();
    const session = await activeRequestForCounselor(counselor.id);
    if (session) await endSession(session.id, 'system');
    await releaseOffers(counselor.id);
  }
}

// Withdraws a counselor's pending offers and passes those requests on.
export async function releaseOffers(counselorId) {
  const pending = await db.select().from(offers)
    .where(and(eq(offers.counselorId, counselorId), eq(offers.status, 'pending')))
    .all();
  for (const offer of pending) {
    await db.update(offers).set({ status: 'cancelled', respondedAt: Date.now() }).where(eq(offers.id, offer.id)).run();
    await reassign(offer.requestId);
  }
}

export async function counselorPanel(counselor, lang) {
  const done = await db.$count(requests, and(eq(requests.counselorId, counselor.id), eq(requests.status, 'ended')));
  return {
    html: t(lang, 'counselorPanel', Boolean(counselor.active), done),
    keyboard: keyboard([[counselor.active ? button(t(lang, 'pause'), 'cp') : button(t(lang, 'resume'), 'cr', 'success')]]),
  };
}

export async function setCounselorActive(counselor, active) {
  await db.update(counselors).set({ active: active ? 1 : 0 }).where(eq(counselors.id, counselor.id)).run();
  if (active) await drainQueue();
  else await releaseOffers(counselor.id);
}

// Removes a counselor (admin action) and passes on their session and offers.
// The row is kept, flagged removed, so their history stays in the statistics.
export async function removeCounselor(counselorId) {
  const counselor = await db.select().from(counselors).where(eq(counselors.id, counselorId)).get();
  if (!counselor) return false;
  const session = await activeRequestForCounselor(counselor.id);
  if (session) {
    // Hand the person back to the queue rather than dropping them.
    await db.update(requests).set({ status: 'waiting', counselorId: null, acceptedAt: null }).where(eq(requests.id, session.id)).run();
    try {
      await sendHtml(session.userId, t(session.lang, 'counselWaiting'), REMOVE_KEYBOARD);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  await db.update(counselors).set({ active: 0, removed: 1 }).where(eq(counselors.id, counselor.id)).run();
  await releaseOffers(counselor.id);
  if (counselor.userId) {
    try {
      await sendHtml(counselor.userId, t(await langOf(counselor.userId), 'counselorRemoved'), REMOVE_KEYBOARD);
    } catch (error) {
      if (!isGone(error)) throw error;
    }
  }
  await drainQueue();
  return true;
}
