import { db } from 'sdk';
import { eq } from 'sdk/db';
import { admins, users } from '../schema.js';
import { AdminError, parseHandle } from './admin.js';
import { t } from './i18n.js';
import { ADMIN_IDS } from './secrets.js';
import { isAdmin, isOwner, setState } from './users.js';

export async function listAdmins(callerId) {
  const owners = [];
  for (const userId of new Set(ADMIN_IDS)) {
    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    owners.push({ userId, displayName: user?.firstName || t('en', 'ownerLabel'), username: user?.username || null,
      owner: true, canRename: false, canRemove: false, self: userId === callerId });
  }
  const rows = await db.all(`SELECT a.user_id AS userId, a.display_name AS displayName,
    a.created_at AS createdAt, u.username, u.first_name AS firstName
    FROM admins a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at, a.user_id`, {});
  return [...owners, ...rows.filter((row) => !isOwner(row.userId)).map((row) => ({
    userId: row.userId, displayName: row.displayName || row.firstName || row.username || String(row.userId),
    username: row.username || null, createdAt: row.createdAt, owner: false,
    canRename: true, canRemove: row.userId !== callerId, self: row.userId === callerId,
  }))];
}

export async function addAdmin(handle, displayName, createdBy) {
  const parsed = parseHandle(handle);
  if (!parsed) throw new AdminError(t('en', 'adminInvalidHandle'));
  let userId = parsed.userId;
  let knownUser;
  if (parsed.username) {
    const matches = await db.select().from(users).where(eq(users.username, parsed.username)).all();
    if (matches.length !== 1) throw new AdminError(t('en', 'adminUsernameUnknown'));
    knownUser = matches[0];
    userId = knownUser.id;
  }
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new AdminError(t('en', 'adminInvalidHandle'));
  if (await isAdmin(userId)) throw new AdminError(t('en', 'adminExists'));
  const [row] = await db.insert(admins).values({
    userId, displayName: String(displayName || '').trim().slice(0, 60) || knownUser?.firstName || '',
    createdBy, createdAt: Date.now(),
  }).onConflictDoNothing({ target: admins.userId }).returning({ userId: admins.userId }).run();
  if (!row) throw new AdminError(t('en', 'adminExists'));
  return row;
}

async function editable(userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new AdminError(t('en', 'adminInvalidHandle'));
  if (isOwner(userId)) throw new AdminError(t('en', 'adminOwnerProtected'));
  const row = await db.select().from(admins).where(eq(admins.userId, userId)).get();
  if (!row) throw new AdminError(t('en', 'adminNotFound'));
  return row;
}

export async function updateAdmin(userId, displayName) {
  await editable(userId);
  if (typeof displayName !== 'string') throw new AdminError(t('en', 'adminInvalidName'));
  await db.update(admins).set({ displayName: displayName.trim().slice(0, 60) }).where(eq(admins.userId, userId)).run();
}

export async function removeAdmin(userId, callerId) {
  await editable(userId);
  if (userId === callerId) throw new AdminError(t('en', 'adminSelfRemoval'));
  await db.delete(admins).where(eq(admins.userId, userId)).run();
  await setState(userId, '');
}
