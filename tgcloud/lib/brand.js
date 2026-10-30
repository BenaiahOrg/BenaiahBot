import { db, fetch } from 'sdk';
import { eq } from 'sdk/db';
import { cache } from '../schema.js';
import { BRAND_ASSETS, BRAND_TTL_MS, SITE_URL } from './constants.js';

const KEY = 'brand:assets';

// The logo URLs currently linked from benaiah.org, refreshed daily.
export async function brandAssets() {
  const row = await db.select().from(cache).where(eq(cache.key, KEY)).get();
  if (row && Date.now() - row.fetchedAt < BRAND_TTL_MS) return row.payload;
  let assets = BRAND_ASSETS;
  try {
    const res = await fetch(SITE_URL);
    if (res.ok) {
      const html = await res.text();
      assets = BRAND_ASSETS.map((asset) => {
        const match = new RegExp(`/_app/immutable/assets/${asset.key}\.[\w-]+\.(?:png|jpe?g)`).exec(html);
        return match ? { ...asset, url: `${SITE_URL}${match[0]}` } : asset;
      });
    }
  } catch {
    // Site unreachable: keep the last known URLs.
    if (row) return row.payload;
  }
  const now = Date.now();
  await db.insert(cache).values({ key: KEY, fetchedAt: now, payload: assets })
    .onConflictDoUpdate({ target: cache.key, set: { fetchedAt: now, payload: assets } })
    .run();
  return assets;
}
