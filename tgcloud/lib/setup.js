import { api, db, BotApiError } from 'sdk';
import { eq } from 'sdk/db';
import { cache } from '../schema.js';
import { addCounselor } from './admin.js';
import { ADMIN_IDS, SEED_COUNSELORS, WEBAPP_URL } from './secrets.js';

// Bump when commands change so the next admin /start reapplies them.
const SETUP_VERSION = 1;
const SETUP_KEY = 'setup:version';

const COMMANDS = {
  en: [
    { command: 'start', description: 'Main menu' },
    { command: 'themes', description: 'Browse themes' },
    { command: 'random', description: 'A random devotional' },
    { command: 'search', description: 'Search topics' },
    { command: 'counsel', description: 'Anonymous counseling' },
    { command: 'language', description: 'Change language' },
  ],
  am: [
    { command: 'start', description: 'ዋና ማውጫ' },
    { command: 'themes', description: 'ርዕሶችን ያስሱ' },
    { command: 'random', description: 'ድንገተኛ ጥሞና' },
    { command: 'search', description: 'ርዕሶችን ይፈልጉ' },
    { command: 'counsel', description: 'ሚስጥራዊ ምክር' },
    { command: 'language', description: 'ቋንቋ ይቀይሩ' },
  ],
};

const ADMIN_COMMANDS = [
  ...COMMANDS.en,
  { command: 'admin', description: 'Open the admin dashboard' },
  { command: 'stats', description: 'Quick statistics' },
];

async function attempt(label, call) {
  try {
    await call();
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    console.warn(`setup: ${label} failed`, error.description);
  }
}

// Admin-only commands and a menu button that opens the dashboard.
export async function setupAdmin(adminId) {
  await attempt(`admin ${adminId} commands`, () => api.setMyCommands({ commands: ADMIN_COMMANDS, scope: { type: 'chat', chat_id: adminId } }));
  if (WEBAPP_URL) {
    await attempt(`admin ${adminId} menu`, () => api.setChatMenuButton({
      chat_id: adminId,
      menu_button: { type: 'web_app', text: 'Dashboard', web_app: { url: WEBAPP_URL } },
    }));
  }
}

export async function runSetup() {
  await attempt('commands', () => api.setMyCommands({ commands: COMMANDS.en }));
  await attempt('commands am', () => api.setMyCommands({ commands: COMMANDS.am, language_code: 'am' }));
  // Fails for admins who haven't opened the bot yet; their /start calls setupAdmin.
  for (const adminId of ADMIN_IDS) await setupAdmin(adminId);
  const seeded = [];
  for (const handle of SEED_COUNSELORS) {
    try {
      await addCounselor(handle);
      seeded.push(handle);
    } catch {
      // Already a counselor, or not a valid handle.
    }
  }
  const now = Date.now();
  await db.insert(cache).values({ key: SETUP_KEY, fetchedAt: now, payload: { version: SETUP_VERSION } })
    .onConflictDoUpdate({ target: cache.key, set: { fetchedAt: now, payload: { version: SETUP_VERSION } } })
    .run();
  return { seeded };
}

export async function setupIfNeeded() {
  const row = await db.select().from(cache).where(eq(cache.key, SETUP_KEY)).get();
  if (row?.payload?.version === SETUP_VERSION) return;
  await runSetup();
}
