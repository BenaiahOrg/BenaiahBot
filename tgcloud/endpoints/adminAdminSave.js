import { EndpointError } from 'sdk';
import { addAdmin, listAdmins, removeAdmin, updateAdmin } from '../lib/access.js';
import { asEndpoint, requireAdmin } from '../lib/guard.js';
import { t } from '../lib/i18n.js';

// Admin grants are bound to Telegram user IDs, resolved server-side.
export default async function (input, ctx) {
  const callerId = await requireAdmin(ctx);
  return asEndpoint(async () => {
    if (input.action === 'add') await addAdmin(input.handle, input.displayName, callerId);
    else if (input.action === 'update') await updateAdmin(Number(input.userId), input.displayName);
    else if (input.action === 'remove') await removeAdmin(Number(input.userId), callerId);
    else throw new EndpointError(t('en', 'adminUnknownAction'), { code: 'INVALID' });
    return { admins: await listAdmins(callerId) };
  });
}
