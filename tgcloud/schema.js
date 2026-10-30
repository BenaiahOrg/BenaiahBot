import { table, integer, text, json, index } from 'sdk/db';

// Times are unix milliseconds (Date.now()). Flags are plain 0/1 integers so raw
// SQL in the stats queries reads them the same way the query builder does.

export const users = table('users', {
  id: integer('id').primaryKey(),
  firstName: text('first_name'),
  username: text('username'),
  lang: text('lang'),
  // What the next plain text message means: '' (nothing) or 'search'.
  state: text('state').notNull().default(''),
  blocked: integer('blocked').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
}, (t) => ({
  createdIdx: index('idx_users_created').on(t.createdAt),
}));

export const counselors = table('counselors', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // Telegram user id; null until someone added by @username opens the bot.
  userId: integer('user_id').unique(),
  username: text('username'),
  displayName: text('display_name').notNull().default(''),
  active: integer('active').notNull().default(1),
  removed: integer('removed').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  usernameIdx: index('idx_counselors_username').on(t.username),
}));

// One anonymous counseling conversation.
// status: intro (waiting for their first message) | searching (offered to a
//         counselor) | waiting (queued, nobody free)
//         | active | ended | cancelled
export const requests = table('requests', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  lang: text('lang').notNull(),
  status: text('status').notNull(),
  counselorId: integer('counselor_id'),
  createdAt: integer('created_at').notNull(),
  acceptedAt: integer('accepted_at'),
  endedAt: integer('ended_at'),
  endedBy: text('ended_by'),
  rating: integer('rating'),
  userMessages: integer('user_messages').notNull().default(0),
  counselorMessages: integer('counselor_messages').notNull().default(0),
  // The person's first message, copied above every offer so counselors can decide.
  introMessageId: integer('intro_message_id'),
}, (t) => ({
  userIdx: index('idx_requests_user').on(t.userId, t.status),
  counselorIdx: index('idx_requests_counselor').on(t.counselorId, t.status),
  statusIdx: index('idx_requests_status').on(t.status, t.createdAt),
}));

// A request shown to one counselor.
// status: pending | accepted | declined | expired | cancelled | failed
export const offers = table('offers', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: integer('request_id').notNull(),
  counselorId: integer('counselor_id').notNull(),
  status: text('status').notNull(),
  messageId: integer('message_id'),
  createdAt: integer('created_at').notNull(),
  respondedAt: integer('responded_at'),
}, (t) => ({
  requestIdx: index('idx_offers_request').on(t.requestId),
  counselorIdx: index('idx_offers_counselor').on(t.counselorId, t.status),
  statusIdx: index('idx_offers_status').on(t.status, t.createdAt),
}));

// Messages a user sent before a counselor accepted; copied over on accept.
// Only Telegram message ids are kept, never the text.
export const queued = table('queued', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  requestId: integer('request_id').notNull(),
  messageId: integer('message_id').notNull(),
}, (t) => ({
  requestIdx: index('idx_queued_request').on(t.requestId),
}));

// Content usage, for the dashboard. kind: subtopic | article | graphics | random | search
export const events = table('events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  kind: text('kind').notNull(),
  key: text('key').notNull().default(''),
  lang: text('lang').notNull().default(''),
  createdAt: integer('created_at').notNull(),
}, (t) => ({
  kindIdx: index('idx_events_kind').on(t.kind, t.createdAt),
}));

// Responses from the Benaiah API, keyed by path.
export const cache = table('cache', {
  key: text('key').primaryKey(),
  fetchedAt: integer('fetched_at').notNull(),
  payload: json('payload').notNull(),
});

// An admin's message copied to every user. Only the source message's id is kept.
// status: draft | sending | done | cancelled. `cursor` is the last user id
// reached, so sending can resume in a later invocation.
export const broadcasts = table('broadcasts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  adminId: integer('admin_id').notNull(),
  messageId: integer('message_id').notNull(),
  audience: text('audience').notNull().default('all'),
  status: text('status').notNull().default('draft'),
  cursor: integer('cursor').notNull().default(0),
  total: integer('total').notNull().default(0),
  sent: integer('sent').notNull().default(0),
  blocked: integer('blocked').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  progressMessageId: integer('progress_message_id'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  finishedAt: integer('finished_at'),
});
