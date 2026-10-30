import { db } from 'sdk';
import { and, eq, isNull } from 'sdk/db';
import { admins, counselors, users } from '../schema.js';
import { ADMIN_IDS } from './secrets.js';

export function isOwner(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

export async function isAdmin(userId) {
  const id = Number(userId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  if (isOwner(id)) return true;
  return Boolean(await db.select({ userId: admins.userId }).from(admins).where(eq(admins.userId, id)).get());
}

// Records the sender and returns their row. `isNew` is true on first contact.
export async function touchUser(from) {
  const now = Date.now();
  const existing = await db.select().from(users).where(eq(users.id, from.id)).get();
  const profile = {
    firstName: from.first_name || '',
    username: from.username ? from.username.toLowerCase() : null,
  };
  if (existing) {
    await db.update(users).set({ ...profile, lastSeenAt: now, blocked: 0 }).where(eq(users.id, from.id)).run();
    return { ...existing, ...profile, blocked: 0, isNew: false };
  }
  // lang stays null until the user picks one, which is what shows the chooser.
  const row = { id: from.id, ...profile, lang: null, state: '', blocked: 0, createdAt: now, lastSeenAt: now };
  await db.insert(users).values(row).onConflictDoNothing({ target: users.id }).run();
  return { ...row, isNew: true };
}

export async function getUser(userId) {
  return db.select().from(users).where(eq(users.id, userId)).get();
}

export async function setLang(userId, lang) {
  await db.update(users).set({ lang }).where(eq(users.id, userId)).run();
}

export async function setState(userId, state) {
  await db.update(users).set({ state }).where(eq(users.id, userId)).run();
}

export async function markBlocked(userId, blocked) {
  await db.update(users).set({ blocked: blocked ? 1 : 0 }).where(eq(users.id, userId)).run();
}

// A counselor added by @username gets their user id the first time they write
// to the bot. Returns the counselor row when this update linked one.
export async function linkCounselor(from) {
  if (!from.username) return null;
  const username = from.username.toLowerCase();
  const pending = await db.select().from(counselors)
    .where(and(eq(counselors.username, username), isNull(counselors.userId), eq(counselors.removed, 0)))
    .get();
  if (!pending) return null;
  const taken = await db.select().from(counselors).where(eq(counselors.userId, from.id)).get();
  if (taken && !taken.removed) return null;
  if (taken) {
    // Re-added after an earlier removal: revive the old row to keep its history.
    await db.delete(counselors).where(eq(counselors.id, pending.id)).run();
    await db.update(counselors).set({ removed: 0, active: 1, username }).where(eq(counselors.id, taken.id)).run();
    return { ...taken, removed: 0, active: 1, username };
  }
  await db.update(counselors)
    .set({ userId: from.id, displayName: pending.displayName || from.first_name || username })
    .where(eq(counselors.id, pending.id))
    .run();
  return { ...pending, userId: from.id };
}

export async function counselorByUser(userId) {
  return db.select().from(counselors).where(and(eq(counselors.userId, userId), eq(counselors.removed, 0))).get();
}
