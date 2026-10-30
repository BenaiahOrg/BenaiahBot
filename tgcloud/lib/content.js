import { db, fetch } from 'sdk';
import { eq } from 'sdk/db';
import { cache } from '../schema.js';
import { API_ORIGIN, ARTICLE_TTL_MS, ARTICLE_TYPES, CATALOG_TTL_MS, LANGS } from './constants.js';

// Older catalog responses have no media fields. Never reuse that cache after
// upgrading to the media-aware API contract, even while its TTL is still fresh.
export const CATALOG_CACHE_KEY = 'catalog:media-v1';

// Fetches a Benaiah API path through the cache table. A stale copy is served
// when the API is unreachable, so the bot keeps working through outages.
async function getJson(path, ttl, cacheKey = path) {
  const row = await db.select().from(cache).where(eq(cache.key, cacheKey)).get();
  if (row && Date.now() - row.fetchedAt < ttl) return row.payload;
  try {
    const res = await fetch(`${API_ORIGIN}${path}`, { headers: { Accept: 'application/json' } });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Benaiah API ${res.status} for ${path}`);
    const payload = await res.json();
    await db.insert(cache).values({ key: cacheKey, fetchedAt: Date.now(), payload })
      .onConflictDoUpdate({ target: cache.key, set: { fetchedAt: Date.now(), payload } })
      .run();
    return payload;
  } catch (error) {
    if (row) return row.payload;
    throw error;
  }
}

function pair(value) {
  return { en: value?.en || '', am: value?.am || '' };
}

function imageList(images, kind) {
  const entry = images?.[kind] || {};
  return { en: Array.isArray(entry.en) ? entry.en : [], am: Array.isArray(entry.am) ? entry.am : [] };
}

// The list endpoint doesn't name subtopic slugs; they are the second-to-last
// segment of each article path.
function subtopicSlug(subtopic) {
  for (const type of ARTICLE_TYPES) {
    for (const lang of LANGS) {
      const path = subtopic.articles?.[type]?.[lang];
      if (path) return path.split('/').filter(Boolean).slice(-2)[0];
    }
  }
  return subtopic.slug || '';
}

function normalizeSubtopic(raw) {
  const articles = {};
  const media = {};
  for (const type of ARTICLE_TYPES) {
    articles[type] = { en: raw.articles?.[type]?.en || null, am: raw.articles?.[type]?.am || null };
    media[type] = {};
    for (const lang of LANGS) {
      const entry = raw.media?.[type]?.[lang];
      media[type][lang] = {
        video: audioUrl(entry?.video),
        short: audioUrl(entry?.short),
        narration: telegramPost(entry?.narration) ? entry.narration.trim() : '',
      };
    }
  }
  return {
    slug: subtopicSlug(raw),
    title: pair(raw.title),
    description: pair(raw.description),
    covers: pair(raw.covers),
    square: imageList(raw.images, 'square'),
    story: imageList(raw.images, 'story'),
    articles,
    media,
  };
}

export async function getCatalog() {
  const raw = await getJson('/api/v1/articles', CATALOG_TTL_MS, CATALOG_CACHE_KEY);
  const themes = (Array.isArray(raw) ? raw : []).map((theme) => ({
    slug: theme.slug,
    title: pair(theme.title),
    subtopics: (theme.subtopics || []).map(normalizeSubtopic).filter((s) => s.slug),
  }));
  return { themes };
}

export function findSubtopic(catalog, ti, si) {
  const theme = catalog.themes[ti];
  const subtopic = theme?.subtopics[si];
  return subtopic ? { theme, subtopic } : null;
}

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Subtopics whose titles or descriptions contain the query, in either language.
export function searchSubtopics(themes, query) {
  const needle = normalize(query);
  const results = [];
  themes.forEach((theme, ti) => theme.subtopics.forEach((subtopic, si) => {
    const haystack = normalize([
      theme.title.en, theme.title.am, subtopic.title.en, subtopic.title.am,
      subtopic.description.en, subtopic.description.am, subtopic.slug,
    ].join(' '));
    if (needle && haystack.includes(needle)) results.push({ ti, si, theme, subtopic });
  }));
  return results;
}

// Authors per article, the artists and the narrators per language; only the
// subtopic endpoint has these.
export async function getSubtopicDetail(themeSlug, subtopicSlug) {
  const raw = await getJson(`/api/v1/articles/${themeSlug}/${subtopicSlug}`, CATALOG_TTL_MS);
  if (!raw) return { authors: {}, artists: [], narrators: {} };
  return { authors: raw.authors || {}, artists: raw.artists || [], narrators: raw.narrators || {} };
}

export async function getArticle(path) {
  if (!path?.startsWith('/api/v1/articles/')) return null;
  return getJson(path, ARTICLE_TTL_MS);
}

export function pick(value, lang) {
  return value?.[lang] || value?.en || value?.am || '';
}

export function personName(person, lang) {
  return person?.[`fullname_${lang}`] || person?.fullname_en || person?.name || '';
}

export function personRole(person, lang) {
  return person?.[`role_${lang}`] || person?.role_en || person?.role || '';
}

// "youtube/<id>" → a watchable URL. Anything else that looks like a URL is kept.
export function audioUrl(audio) {
  const value = String(audio || '').trim();
  if (!value) return '';
  const youtube = /^youtube\/([\w-]+)$/.exec(value);
  if (youtube) return `https://www.youtube.com/watch?v=${youtube[1]}`;
  if (/^https?:\/\//.test(value)) return value;
  return '';
}

// Public channel post links and private /c/ links use different chat IDs.
export function telegramPost(url) {
  const match = /^https:\/\/(?:t\.me|telegram\.me)\/(?:s\/)?([a-zA-Z][a-zA-Z0-9_]{3,31}|c\/[1-9]\d*)\/([1-9]\d*)(?:[?#].*)?$/.exec(String(url || '').trim());
  if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
  return {
    from_chat_id: match[1].startsWith('c/') ? `-100${match[1].slice(2)}` : `@${match[1]}`,
    message_id: Number(match[2]),
  };
}

// The website addresses articles by English titles, as its RSS feed does.
export function articleWebUrl(theme, subtopic, type, lang) {
  const parts = ['articles', 'themes', theme.title.en, subtopic.title.en, `${type}_${lang}`];
  return `${API_ORIGIN}/${parts.map(encodeURIComponent).join('/')}`;
}
