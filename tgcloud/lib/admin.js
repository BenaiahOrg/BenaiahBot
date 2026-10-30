import { db, BotApiError } from 'sdk';
import { and, eq } from 'sdk/db';
import { counselors, users } from '../schema.js';
import { drainQueue, removeCounselor, setCounselorActive } from './counseling.js';
import { t } from './i18n.js';
import { sendHtml } from './ui.js';

const DAY = 24 * 60 * 60 * 1000;

// A refusal whose message is safe to show the admin.
export class AdminError extends Error {}

// "@name", "name", "https://t.me/name" or a numeric user id.
export function parseHandle(raw) {
  const value = String(raw || '').trim().replace(/^https?:\/\/t\.me\//i, '').replace(/^@/, '');
  // Usernames start with a letter, so anything all-digit is a user id.
  if (/^\d{1,15}$/.test(value)) return { userId: Number(value) };
  if (/^[a-zA-Z][\w]{3,31}$/.test(value)) return { username: value.toLowerCase() };
  return null;
}

async function welcome(userId) {
  const user = await db.select({ lang: users.lang }).from(users).where(eq(users.id, userId)).get();
  try {
    await sendHtml(userId, t(user?.lang || 'en', 'counselorWelcome'));
    return true;
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    return false;
  }
}

// Adds (or revives) a counselor. Throws AdminError when the input is refused.
export async function addCounselor(handle, displayName = '') {
  const parsed = parseHandle(handle);
  if (!parsed) throw new AdminError('Enter a @username or a numeric Telegram user id.');
  let userId = parsed.userId ?? null;
  const username = parsed.username ?? null;
  let knownUser = null;
  if (username) {
    knownUser = await db.select().from(users).where(eq(users.username, username)).get();
    if (knownUser) userId = knownUser.id;
  } else {
    knownUser = await db.select().from(users).where(eq(users.id, userId)).get();
  }
  const name = String(displayName || '').trim().slice(0, 60) || knownUser?.firstName || username || '';

  const existing = (userId && await db.select().from(counselors).where(eq(counselors.userId, userId)).get())
    || (username && await db.select().from(counselors).where(and(eq(counselors.username, username), eq(counselors.removed, 0))).get());
  let id;
  if (existing && !existing.removed) throw new AdminError('That person is already a counselor.');
  if (existing) {
    await db.update(counselors)
      .set({ removed: 0, active: 1, username: username ?? existing.username, displayName: name || existing.displayName })
      .where(eq(counselors.id, existing.id))
      .run();
    id = existing.id;
  } else {
    const [row] = await db.insert(counselors).values({
      userId, username: username ?? knownUser?.username ?? null, displayName: name, active: 1, removed: 0, createdAt: Date.now(),
    }).returning({ id: counselors.id });
    id = row.id;
  }
  // Someone who has never opened the bot can't be messaged yet; they are
  // welcomed (and become reachable) when they first write to it.
  const reachable = userId && knownUser ? await welcome(userId) : false;
  if (reachable) await drainQueue();
  return { id, linked: Boolean(userId), reachable };
}

export async function updateCounselor(id, changes) {
  const counselor = await db.select().from(counselors).where(and(eq(counselors.id, id), eq(counselors.removed, 0))).get();
  if (!counselor) throw new AdminError('Counselor not found.');
  if (typeof changes.displayName === 'string') {
    await db.update(counselors).set({ displayName: changes.displayName.trim().slice(0, 60) }).where(eq(counselors.id, id)).run();
  }
  if (typeof changes.active === 'boolean' && Boolean(counselor.active) !== changes.active) {
    await setCounselorActive(counselor, changes.active);
  }
}

export async function deleteCounselor(id) {
  if (!await removeCounselor(id)) throw new AdminError('Counselor not found.');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// Per-counselor numbers. Offers count every time a request was shown to them.
const COUNSELOR_STATS = `
  SELECT c.id, c.user_id AS userId, c.username, c.display_name AS displayName, c.active, c.created_at AS createdAt,
    (SELECT count(*) FROM offers o WHERE o.counselor_id = c.id) AS offers,
    (SELECT count(*) FROM offers o WHERE o.counselor_id = c.id AND o.status = 'accepted') AS accepted,
    (SELECT count(*) FROM offers o WHERE o.counselor_id = c.id AND o.status = 'declined') AS declined,
    (SELECT count(*) FROM offers o WHERE o.counselor_id = c.id AND o.status = 'expired') AS expired,
    (SELECT count(*) FROM offers o WHERE o.counselor_id = c.id AND o.status = 'failed') AS failed,
    (SELECT avg(o.responded_at - o.created_at) FROM offers o WHERE o.counselor_id = c.id AND o.status IN ('accepted', 'declined')) AS avgResponseMs,
    (SELECT count(*) FROM requests r WHERE r.counselor_id = c.id AND r.status = 'ended') AS sessions,
    (SELECT count(*) FROM requests r WHERE r.counselor_id = c.id AND r.status = 'active') AS activeNow,
    (SELECT count(*) FROM offers o WHERE o.counselor_id = c.id AND o.status = 'pending') AS pendingNow,
    (SELECT avg(r.rating) FROM requests r WHERE r.counselor_id = c.id AND r.rating IS NOT NULL) AS avgRating,
    (SELECT count(r.rating) FROM requests r WHERE r.counselor_id = c.id) AS ratings,
    (SELECT avg(r.ended_at - r.accepted_at) FROM requests r WHERE r.counselor_id = c.id AND r.status = 'ended') AS avgSessionMs,
    (SELECT coalesce(sum(r.counselor_messages), 0) FROM requests r WHERE r.counselor_id = c.id) AS messagesSent,
    (SELECT max(o.created_at) FROM offers o WHERE o.counselor_id = c.id) AS lastOfferAt
  FROM counselors c WHERE c.removed = 0`;

function counselorRow(row) {
  return {
    id: row.id,
    userId: row.userId ?? null,
    username: row.username ?? null,
    displayName: row.displayName || row.username || String(row.userId ?? ''),
    active: Boolean(row.active),
    linked: row.userId != null,
    createdAt: row.createdAt,
    offers: num(row.offers),
    accepted: num(row.accepted),
    declined: num(row.declined),
    expired: num(row.expired),
    failed: num(row.failed),
    acceptRate: num(row.offers) ? num(row.accepted) / num(row.offers) : null,
    avgResponseMs: row.avgResponseMs == null ? null : num(row.avgResponseMs),
    sessions: num(row.sessions),
    busy: num(row.activeNow) > 0,
    pending: num(row.pendingNow) > 0,
    avgRating: row.avgRating == null ? null : num(row.avgRating),
    ratings: num(row.ratings),
    avgSessionMs: row.avgSessionMs == null ? null : num(row.avgSessionMs),
    messagesSent: num(row.messagesSent),
    lastOfferAt: row.lastOfferAt ?? null,
  };
}

export async function listCounselors() {
  const rows = await db.all(`${COUNSELOR_STATS} ORDER BY c.active DESC, c.display_name COLLATE NOCASE`, {});
  return rows.map(counselorRow);
}

function requestRow(row) {
  return {
    id: row.id,
    status: row.status,
    lang: row.lang,
    counselor: row.counselor || null,
    createdAt: row.createdAt,
    waitMs: row.acceptedAt ? row.acceptedAt - row.createdAt : null,
    durationMs: row.acceptedAt && row.endedAt ? row.endedAt - row.acceptedAt : null,
    endedBy: row.endedBy || null,
    rating: row.rating ?? null,
    userMessages: num(row.userMessages),
    counselorMessages: num(row.counselorMessages),
    offers: num(row.offers),
  };
}

// Requests never name the person who asked: the dashboard is anonymous too.
const REQUEST_SELECT = `
  SELECT r.id, r.status, r.lang, r.created_at AS createdAt, r.accepted_at AS acceptedAt, r.ended_at AS endedAt,
    r.ended_by AS endedBy, r.rating, r.user_messages AS userMessages, r.counselor_messages AS counselorMessages,
    coalesce(nullif(c.display_name, ''), c.username) AS counselor,
    (SELECT count(*) FROM offers o WHERE o.request_id = r.id) AS offers
  FROM requests r LEFT JOIN counselors c ON c.id = r.counselor_id`;

export async function counselorDetail(id) {
  const row = await db.get(`${COUNSELOR_STATS} AND c.id = :id`, { ':id': id });
  if (!row) throw new AdminError('Counselor not found.');
  const history = await db.all(`
    SELECT o.id, o.request_id AS requestId, o.status, o.created_at AS createdAt, o.responded_at AS respondedAt,
      r.status AS requestStatus, r.lang, r.rating, r.accepted_at AS acceptedAt, r.ended_at AS endedAt,
      r.user_messages AS userMessages, r.counselor_messages AS counselorMessages
    FROM offers o LEFT JOIN requests r ON r.id = o.request_id
    WHERE o.counselor_id = :id ORDER BY o.id DESC LIMIT 30`, { ':id': id });
  return {
    counselor: counselorRow(row),
    history: history.map((h) => ({
      offerId: h.id,
      requestId: h.requestId,
      status: h.status,
      createdAt: h.createdAt,
      responseMs: h.respondedAt ? h.respondedAt - h.createdAt : null,
      lang: h.lang,
      // The rating belongs to whoever held the session, not to those who passed.
      rating: h.status === 'accepted' ? h.rating ?? null : null,
      durationMs: h.status === 'accepted' && h.acceptedAt && h.endedAt ? h.endedAt - h.acceptedAt : null,
      live: h.status === 'accepted' && h.requestStatus === 'active',
      messages: h.status === 'accepted' ? num(h.userMessages) + num(h.counselorMessages) : null,
    })),
  };
}

async function count(query, params = {}) {
  const row = await db.get(query, params);
  return num(row?.n);
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function dailySeries(query, since) {
  const rows = await db.all(query, { ':since': since });
  const byDay = Object.fromEntries(rows.map((row) => [row.day, num(row.n)]));
  const days = [];
  for (let ms = since; ms <= Date.now(); ms += DAY) days.push(dayKey(ms));
  return days.map((day) => ({ day, n: byDay[day] || 0 }));
}

export async function dashboard() {
  const now = Date.now();
  const week = now - 7 * DAY;
  const month = now - 30 * DAY;
  const since = new Date(dayKey(now - 13 * DAY)).getTime();
  const day = `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')`;

  const langRows = await db.all(`SELECT coalesce(lang, '') AS lang, count(*) AS n FROM users GROUP BY 1`, {});
  const byLang = Object.fromEntries(langRows.map((row) => [row.lang || 'unset', num(row.n)]));

  const statusRows = await db.all(`SELECT status, count(*) AS n FROM requests GROUP BY status`, {});
  const byStatus = Object.fromEntries(statusRows.map((row) => [row.status, num(row.n)]));
  const offerRows = await db.all(`SELECT status, count(*) AS n FROM offers GROUP BY status`, {});
  const offersByStatus = Object.fromEntries(offerRows.map((row) => [row.status, num(row.n)]));
  const timing = await db.get(`
    SELECT avg(accepted_at - created_at) AS wait, avg(CASE WHEN status = 'ended' THEN ended_at - accepted_at END) AS duration,
      avg(rating) AS rating, count(rating) AS ratings,
      coalesce(sum(user_messages), 0) + coalesce(sum(counselor_messages), 0) AS messages
    FROM requests WHERE accepted_at IS NOT NULL`, {});

  const kindRows = await db.all(`SELECT kind, count(*) AS n, sum(CASE WHEN created_at >= :week THEN 1 ELSE 0 END) AS week FROM events GROUP BY kind`, { ':week': week });
  const content = Object.fromEntries(kindRows.map((row) => [row.kind, { total: num(row.n), week: num(row.week) }]));
  const topArticles = await db.all(`SELECT key, count(*) AS n FROM events WHERE kind = 'article' GROUP BY key ORDER BY n DESC LIMIT 10`, {});
  const topSearches = await db.all(`SELECT lower(key) AS key, count(*) AS n FROM events WHERE kind = 'search' GROUP BY 1 ORDER BY n DESC LIMIT 10`, {});

  const recent = await db.all(`${REQUEST_SELECT} ORDER BY r.id DESC LIMIT 30`, {});
  const counselorList = await listCounselors();

  return {
    generatedAt: now,
    users: {
      total: await count(`SELECT count(*) AS n FROM users`),
      newWeek: await count(`SELECT count(*) AS n FROM users WHERE created_at >= :t`, { ':t': week }),
      newMonth: await count(`SELECT count(*) AS n FROM users WHERE created_at >= :t`, { ':t': month }),
      activeWeek: await count(`SELECT count(*) AS n FROM users WHERE last_seen_at >= :t`, { ':t': week }),
      blocked: await count(`SELECT count(*) AS n FROM users WHERE blocked = 1`),
      byLang,
    },
    content: { byKind: content, topArticles: topArticles.map((row) => ({ key: row.key, n: num(row.n) })), topSearches: topSearches.map((row) => ({ key: row.key, n: num(row.n) })) },
    counseling: {
      requests: Object.values(byStatus).reduce((a, b) => a + b, 0),
      byStatus,
      offers: offersByStatus,
      accepted: offersByStatus.accepted || 0,
      declined: offersByStatus.declined || 0,
      expired: offersByStatus.expired || 0,
      avgWaitMs: timing?.wait == null ? null : num(timing.wait),
      avgSessionMs: timing?.duration == null ? null : num(timing.duration),
      avgRating: timing?.rating == null ? null : num(timing.rating),
      ratings: num(timing?.ratings),
      messages: num(timing?.messages),
      counselors: counselorList.length,
      counselorsAvailable: counselorList.filter((c) => c.active && c.linked && !c.busy).length,
    },
    series: {
      users: await dailySeries(`SELECT ${day} AS day, count(*) AS n FROM users WHERE created_at >= :since GROUP BY 1`, since),
      reads: await dailySeries(`SELECT ${day} AS day, count(*) AS n FROM events WHERE kind = 'article' AND created_at >= :since GROUP BY 1`, since),
      requests: await dailySeries(`SELECT ${day} AS day, count(*) AS n FROM requests WHERE created_at >= :since GROUP BY 1`, since),
    },
    counselors: counselorList,
    requests: recent.map(requestRow),
  };
}

// A compact text version for the /stats command.
export async function statsText() {
  const d = await dashboard();
  const c = d.counseling;
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  return [
    '📊 <b>Benaiah bot</b>',
    '',
    `<b>Users</b>: ${d.users.total} (EN ${d.users.byLang.en || 0} · AM ${d.users.byLang.am || 0})`,
    `New this week: ${d.users.newWeek} · active this week: ${d.users.activeWeek}`,
    `Articles read: ${d.content.byKind.article?.total || 0} (${d.content.byKind.article?.week || 0} this week)`,
    '',
    `<b>Counseling</b>: ${c.requests} requests · ${c.byStatus.active || 0} live · ${c.byStatus.waiting || 0} queued`,
    `Offers: ${c.accepted} accepted · ${c.declined} declined · ${c.expired} expired (accept rate ${pct(c.accepted, c.accepted + c.declined + c.expired)})`,
    `Counselors: ${c.counselors} (${c.counselorsAvailable} free now)`,
    c.avgRating != null ? `Average rating: ${c.avgRating.toFixed(1)} ⭐ (${c.ratings})` : '',
  ].filter((line) => line !== null).join('\n');
}
