import { EndpointError } from 'sdk';
import { AdminError } from './admin.js';
import { isAdmin } from './users.js';

// Endpoints run only for verified Mini App users; this narrows them to admins.
export async function requireAdmin(ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId || !await isAdmin(userId)) throw new EndpointError('Admins only', { code: 'FORBIDDEN' });
  return userId;
}

// Turns an AdminError into a 400 whose message the dashboard shows.
export async function asEndpoint(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AdminError) throw new EndpointError(error.message, { code: 'INVALID' });
    throw error;
  }
}
