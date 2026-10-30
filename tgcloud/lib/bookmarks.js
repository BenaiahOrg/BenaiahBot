import { db } from 'sdk';
import { and, desc, eq } from 'sdk/db';
import { bookmarks } from '../schema.js';
import { ARTICLE_TYPES, LANGS } from './constants.js';
import { pick } from './content.js';

export const BOOKMARKS_PER_PAGE = 8;

function articleWhere(userId, themeSlug, subtopicSlug, type, lang) {
  return and(eq(bookmarks.userId, userId), eq(bookmarks.themeSlug, themeSlug), eq(bookmarks.subtopicSlug, subtopicSlug),
    eq(bookmarks.articleType, type), eq(bookmarks.lang, lang));
}

export async function findBookmark(userId, themeSlug, subtopicSlug, type, lang) {
  return db.select().from(bookmarks).where(articleWhere(userId, themeSlug, subtopicSlug, type, lang)).get();
}

export async function saveBookmark(userId, theme, subtopic, type, lang) {
  if (!ARTICLE_TYPES.includes(type) || !LANGS.includes(lang) || !subtopic.articles[type]?.[lang]) return null;
  // Both simultaneous clicks and repeated taps leave a single saved article.
  await db.insert(bookmarks).values({ userId, themeSlug: theme.slug, subtopicSlug: subtopic.slug,
    articleType: type, lang, title: pick(subtopic.title, lang), createdAt: Date.now() })
    .onConflictDoNothing().run();
  return findBookmark(userId, theme.slug, subtopic.slug, type, lang);
}

export async function getBookmark(userId, id) {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return db.select().from(bookmarks).where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId))).get();
}

export async function removeBookmark(userId, id) {
  const row = await getBookmark(userId, id);
  if (row) await db.delete(bookmarks).where(and(eq(bookmarks.id, id), eq(bookmarks.userId, userId))).run();
  return Boolean(row);
}

export async function listBookmarks(userId, page = 0) {
  const where = eq(bookmarks.userId, userId);
  const total = await db.$count(bookmarks, where);
  const pages = Math.max(1, Math.ceil(total / BOOKMARKS_PER_PAGE));
  const current = Math.min(Math.max(Number.isSafeInteger(page) ? page : 0, 0), pages - 1);
  const rows = await db.select().from(bookmarks).where(where).orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .limit(BOOKMARKS_PER_PAGE).offset(current * BOOKMARKS_PER_PAGE).all();
  return { rows, total, pages, page: current };
}
