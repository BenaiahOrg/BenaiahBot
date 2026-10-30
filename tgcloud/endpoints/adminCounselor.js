import { counselorDetail } from '../lib/admin.js';
import { asEndpoint, requireAdmin } from '../lib/guard.js';

// POST /api/adminCounselor { id } — one counselor's numbers and recent offers.
export default async function (input, ctx) {
  requireAdmin(ctx);
  return asEndpoint(() => counselorDetail(Number(input.id)));
}
