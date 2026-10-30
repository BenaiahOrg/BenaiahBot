import { dashboard } from '../lib/admin.js';
import { sweep } from '../lib/counseling.js';
import { requireAdmin } from '../lib/guard.js';
import { listAdmins } from '../lib/access.js';
import { t } from '../lib/i18n.js';

// POST /api/adminDashboard — every number the dashboard shows, in one call.
export default async function (input, ctx) {
  const callerId = await requireAdmin(ctx);
  // Opening the dashboard also moves stale offers along.
  await sweep();
  return { ...await dashboard(), callerId, admins: await listAdmins(callerId), managementUi: t('en', 'managementUi') };
}
