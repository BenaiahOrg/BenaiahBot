import { dashboard } from '../lib/admin.js';
import { sweep } from '../lib/counseling.js';
import { requireAdmin } from '../lib/guard.js';

// POST /api/adminDashboard — every number the dashboard shows, in one call.
export default async function (input, ctx) {
  requireAdmin(ctx);
  // Opening the dashboard also moves stale offers along.
  await sweep();
  return dashboard();
}
