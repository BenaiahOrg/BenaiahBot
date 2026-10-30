import { requireAdmin } from '../lib/guard.js';
import { runSetup } from '../lib/setup.js';

// POST /api/setup — registers commands and menu buttons and seeds counselors
// from .env. scripts/cloud.mjs runs it after each deploy.
export default async function (input, ctx) {
  requireAdmin(ctx);
  return runSetup();
}
