import { api, db, BotApiError } from 'sdk';
import { and, asc, desc, eq, gt, inArray, lte } from 'sdk/db';
import { broadcasts, cache, users } from '../schema.js';
import { t } from './i18n.js';
import { button, keyboard, sendHtml } from './ui.js';
import { isAdmin, markBlocked, setState } from './users.js';

// Each click sends a bounded batch so a serverless invocation stays short.
export const BROADCAST_BATCH_SIZE = 20;
const LEASE_MS = 2 * 60 * 1000;
const PENDING = ['draft', 'ready', 'sending'];

function cancelKeyboard(lang, id = 0) {
  return keyboard([[button(t(lang, 'broadcastCancel'), `BCX:${id}`)]]);
}

async function owned(adminId, id) {
  if (!await isAdmin(adminId)) return null;
  return db.select().from(broadcasts).where(and(eq(broadcasts.id, id), eq(broadcasts.adminId, adminId))).get();
}

function recipients(row) {
  return and(eq(users.blocked, 0), lte(users.createdAt, row.createdAt), gt(users.id, row.cursor));
}

async function statusMessage(row, lang, notice = '') {
  const pending = PENDING.includes(row.status);
  const label = row.status === 'done' ? 'broadcastDone' : row.status === 'cancelled' ? 'broadcastCancelledStatus' : 'broadcastReady';
  const html = row.status === 'draft'
    ? t(lang, 'broadcastPreview', row.total)
    : t(lang, 'broadcastProgress', t(lang, label), row.sent, row.total, row.blocked, row.failed);
  return sendHtml(row.adminId, [notice, html].filter(Boolean).join('\n\n'), keyboard([
    pending ? [button(t(lang, row.status === 'draft' ? 'broadcastSend' : 'broadcastContinue'), `BCS:${row.id}`, 'primary')] : null,
    pending ? [button(t(lang, 'broadcastCancel'), `BCX:${row.id}`)] : null,
    [button(t(lang, 'home'), 'M')],
  ]));
}

export async function beginBroadcast(adminId, lang) {
  if (!await isAdmin(adminId)) return sendHtml(adminId, t(lang, 'adminOnly'));
  const pending = await db.select().from(broadcasts)
    .where(and(eq(broadcasts.adminId, adminId), inArray(broadcasts.status, PENDING)))
    .orderBy(desc(broadcasts.id)).get();
  await setState(adminId, pending ? '' : 'broadcast');
  if (pending) return statusMessage(pending, lang);
  return sendHtml(adminId, t(lang, 'broadcastPrompt'), cancelKeyboard(lang));
}

export async function draftBroadcast(message, user, lang) {
  if (!await isAdmin(user.id)) {
    await setState(user.id, '');
    return sendHtml(user.id, t(lang, 'adminOnly'));
  }
  const supported = ['text', 'photo', 'video', 'audio', 'voice', 'document', 'animation', 'sticker', 'video_note'];
  if (message.media_group_id || !supported.some((key) => message[key])) {
    return sendHtml(user.id, t(lang, 'broadcastUnsupported'), cancelKeyboard(lang));
  }
  let preview;
  try {
    preview = await api.copyMessage({ chat_id: user.id, from_chat_id: user.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] } });
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    return sendHtml(user.id, t(lang, 'broadcastPreviewFailed'), cancelKeyboard(lang));
  }
  const now = Date.now();
  const total = await db.$count(users, and(eq(users.blocked, 0), lte(users.createdAt, now)));
  // Copy from the bot's preview, so editing/deleting the original cannot alter it.
  const [row] = await db.insert(broadcasts).values({
    adminId: user.id, messageId: preview.message_id, createdAt: now, total,
  }).returning().run();
  await setState(user.id, '');
  return statusMessage(row, lang);
}

export async function cancelBroadcast(adminId, id, lang) {
  if (!await isAdmin(adminId)) return sendHtml(adminId, t(lang, 'adminOnly'));
  // The composition prompt's Cancel button may still be visible after preview.
  if (!id) {
    const pending = await db.select().from(broadcasts)
      .where(and(eq(broadcasts.adminId, adminId), inArray(broadcasts.status, PENDING)))
      .orderBy(desc(broadcasts.id)).get();
    id = pending?.id || 0;
  }
  if (id) {
    const row = await owned(adminId, id);
    if (!row) return sendHtml(adminId, t(lang, 'broadcastMissing'));
    await db.update(broadcasts).set({ status: 'cancelled', finishedAt: Date.now() })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.adminId, adminId), inArray(broadcasts.status, PENDING))).run();
    if (!PENDING.includes(row.status)) return statusMessage(row, lang);
  }
  await setState(adminId, '');
  return sendHtml(adminId, t(lang, 'broadcastCancelled'), keyboard([[button(t(lang, 'home'), 'M')]]));
}

export async function sendBroadcastBatch(adminId, id, lang) {
  if (!await isAdmin(adminId)) return sendHtml(adminId, t(lang, 'adminOnly'));
  let row = await owned(adminId, id);
  if (!row) return sendHtml(adminId, t(lang, 'broadcastMissing'));
  if (!PENDING.includes(row.status)) return statusMessage(row, lang);
  const retryKey = `broadcast:retry:${id}`;
  const retry = await db.select().from(cache).where(eq(cache.key, retryKey)).get();
  if (retry?.payload?.until > Date.now()) {
    return statusMessage(row, lang, t(lang, 'broadcastRetry', Math.ceil((retry.payload.until - Date.now()) / 1000)));
  }
  if (row.status === 'sending' && row.startedAt > Date.now() - LEASE_MS) {
    return statusMessage(row, lang, t(lang, 'broadcastBusy'));
  }
  // Compare-and-set prevents two clicks/workers from delivering the same batch.
  const [claimed] = await db.update(broadcasts).set({ status: 'sending', startedAt: Date.now() })
    .where(and(eq(broadcasts.id, id), eq(broadcasts.adminId, adminId), eq(broadcasts.status, row.status),
      row.status === 'sending' ? eq(broadcasts.startedAt, row.startedAt) : inArray(broadcasts.status, ['draft', 'ready'])))
    .returning().run();
  if (!claimed) return sendHtml(adminId, t(lang, 'broadcastBusy'));
  row = claimed;
  let notice = '';
  try {
    const batch = await db.select({ id: users.id }).from(users).where(recipients(row))
      .orderBy(asc(users.id)).limit(BROADCAST_BATCH_SIZE).all();
    for (const recipient of batch) {
      const current = await owned(adminId, id);
      if (!current) return sendHtml(adminId, t(lang, 'adminOnly'));
      if (current.status !== 'sending' || current.startedAt !== row.startedAt) return statusMessage(current, lang);
      try {
        await api.copyMessage({ chat_id: recipient.id, from_chat_id: adminId, message_id: row.messageId, reply_markup: { inline_keyboard: [] } });
        row.sent += 1;
      } catch (error) {
        if (!(error instanceof BotApiError)) throw error;
        if (error.code === 429) {
          const seconds = Math.max(1, Number(error.parameters?.retry_after) || 30);
          const now = Date.now();
          const payload = { until: now + seconds * 1000 };
          await db.insert(cache).values({ key: retryKey, fetchedAt: now, payload })
            .onConflictDoUpdate({ target: cache.key, set: { fetchedAt: now, payload } }).run();
          notice = t(lang, 'broadcastRetry', seconds);
          break; // Leave the cursor before this recipient so Continue retries them.
        }
        if (error.code === 403 || /chat not found|user is deactivated/i.test(error.description || '')) {
          await markBlocked(recipient.id, true);
          row.blocked += 1;
        } else if (/message.*(?:not found|can't be copied|cannot be copied)/i.test(error.description || '')) {
          notice = t(lang, 'broadcastSourceMissing');
          break;
        } else if (error.code >= 500) {
          notice = t(lang, 'broadcastPaused');
          break;
        } else {
          row.failed += 1;
        }
      }
      row.cursor = recipient.id;
      // Persist each result before moving to the next user.
      await db.update(broadcasts).set({ cursor: row.cursor, sent: row.sent, blocked: row.blocked, failed: row.failed })
        .where(and(eq(broadcasts.id, id), eq(broadcasts.startedAt, row.startedAt))).run();
    }
    const remaining = await db.select({ id: users.id }).from(users).where(recipients(row)).get();
    await db.update(broadcasts).set({ status: remaining ? 'ready' : 'done', finishedAt: remaining ? null : Date.now() })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, 'sending'), eq(broadcasts.startedAt, row.startedAt))).run();
  } catch (error) {
    await db.update(broadcasts).set({ status: 'ready' })
      .where(and(eq(broadcasts.id, id), eq(broadcasts.status, 'sending'), eq(broadcasts.startedAt, row.startedAt))).run();
    console.error('Broadcast batch paused', error?.message || error);
    notice = t(lang, 'broadcastPaused');
  }
  const current = await owned(adminId, id);
  return current ? statusMessage(current, lang, notice) : sendHtml(adminId, t(lang, 'adminOnly'));
}
