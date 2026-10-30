import fs from 'node:fs';
import path from 'node:path';
import { list, readEnv } from './env.mjs';

// Reads .env and writes tgcloud/lib/secrets.js, the only way configuration reaches
// the deployed modules (they have no process.env).

const root = process.cwd();
const envPath = path.join(root, '.env');
if (!fs.existsSync(envPath)) {
  console.error('No .env found. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
const env = readEnv(envPath);

const adminIds = list(env.ADMIN_IDS).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
if (!adminIds.length) {
  console.error('ADMIN_IDS is missing from .env (your numeric Telegram user id; ask @userinfobot).');
  process.exit(1);
}

// The CLI token is app<id>:<secret>; the app id is public and names the Mini App host.
const appId = /^app(\d+):/.exec(env.TGCLOUD || '')?.[1];
const webAppUrl = env.WEBAPP_URL || (appId ? `https://app${appId}.tgcloud.ai/` : '');
if (!webAppUrl) console.warn('TGCLOUD is missing, so the admin dashboard URL is unknown. Set WEBAPP_URL or TGCLOUD.');

const secrets = {
  ADMIN_IDS: adminIds,
  WEBAPP_URL: webAppUrl,
  SEED_COUNSELORS: list(env.COUNSELORS),
};

const lines = Object.entries(secrets).map(
  ([name, value]) => `export const ${name} = ${JSON.stringify(value)};`,
);
const target = path.join(root, 'tgcloud', 'lib', 'secrets.js');
fs.writeFileSync(target, `// Generated from .env by scripts/write-secrets.mjs. Do not commit.\n${lines.join('\n')}\n`);
console.log(`Wrote tgcloud/lib/secrets.js (${adminIds.length} admin(s), ${secrets.SEED_COUNSELORS.length} seed counselor(s), dashboard ${webAppUrl || 'unset'})`);
