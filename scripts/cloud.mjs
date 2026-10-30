import { spawn } from 'node:child_process';
import path from 'node:path';
import { list, readEnv } from './env.mjs';

// Deploys the modules and the dashboard, then applies schema changes.
// Uses TGCLOUD from .env so no interactive `tgcloud login` is needed.

const env = readEnv(path.join(process.cwd(), '.env'));
if (!env.TGCLOUD) {
  console.error('TGCLOUD is missing from .env');
  process.exit(1);
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tgcloud', ...args], {
      env: { ...process.env, TGCLOUD_TOKEN: env.TGCLOUD },
      stdio: 'inherit',
      shell: true,
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tgcloud ${args.join(' ')} exited ${code}`));
    });
  });
}

await run(['push']);
await run(['migrate', '--yes']);
// Registers commands, menu buttons and seed counselors (safe to run on every deploy).
const adminId = Number(list(env.ADMIN_IDS)[0]);
// No spaces or quotes in the JSON5 arguments, so they survive both cmd.exe and sh.
await run(['run', 'endpoints/setup', '{}', '--ctx', `{initData:{user:{id:${adminId}}}}`]);
