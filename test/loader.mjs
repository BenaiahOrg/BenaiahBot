// Resolves the platform's bare `sdk` imports (and the generated secrets) to the
// local fakes, so tgcloud/ modules run unmodified under Node.
const here = new URL('./', import.meta.url);

const MAP = {
  sdk: 'fake-sdk.mjs',
  'sdk/api': 'fake-sdk.mjs',
  'sdk/fetch': 'fake-sdk.mjs',
  'sdk/db': 'fake-db.mjs',
};

export async function resolve(specifier, context, next) {
  if (MAP[specifier]) return { url: new URL(MAP[specifier], here).href, shortCircuit: true };
  if (specifier.endsWith('/secrets.js') && context.parentURL?.includes('/tgcloud/lib/')) {
    return { url: new URL('secrets.mjs', here).href, shortCircuit: true };
  }
  return next(specifier, context);
}
