import { EndpointError } from 'sdk';
import { addCounselor, deleteCounselor, listCounselors, updateCounselor } from '../lib/admin.js';
import { asEndpoint, requireAdmin } from '../lib/guard.js';

// POST /api/adminCounselorSave
//   { action: 'add', handle, displayName }
//   { action: 'update', id, displayName?, active? }
//   { action: 'remove', id }
// Returns the refreshed counselor list.
export default async function (input, ctx) {
  await requireAdmin(ctx);
  return asEndpoint(async () => {
    let result = {};
    if (input.action === 'add') result = await addCounselor(input.handle, input.displayName);
    else if (input.action === 'update') await updateCounselor(Number(input.id), { displayName: input.displayName, active: input.active });
    else if (input.action === 'remove') await deleteCounselor(Number(input.id));
    else throw new EndpointError('Unknown action', { code: 'INVALID' });
    return { ...result, counselors: await listCounselors() };
  });
}
