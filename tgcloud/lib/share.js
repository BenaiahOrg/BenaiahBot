import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { users } from '../schema.js';
import { ARTICLE_TYPES } from './constants.js';
import { articleWebUrl, getCatalog, pick, searchSubtopics } from './content.js';
import { photoUrl } from './files.js';
import { clip, escapeHtml } from './format.js';
import { t } from './i18n.js';

// Sharing uses inline mode: a switch_inline_query button opens Telegram's chat
// picker, then the chosen chat receives an article card with buttons. Inline mode
// must be enabled for the bot with /setinline in BotFather.

const TYPE_WORD = { devotional: 'devotional', study_material: 'study' };
const WORD_TYPE = { devotional: 'devotional', study: 'study_material' };
const TYPE_CODE = { devotional: 'd', study_material: 's' };
const CODE_TYPE = { d: 'devotional', s: 'study_material' };

const MAX_RESULTS = 20;

// The text after @bot in the chat picker, naming exactly one article.
export function shareQuery(subtopic, type, lang) {
  return `${subtopic.slug} ${TYPE_WORD[type]} ${lang}`;
}

export function shareButton(lang, subtopic, type, articleLang) {
  return { text: t(lang, 'shareArticle'), switch_inline_query: shareQuery(subtopic, type, articleLang) };
}

function parseShareQuery(query) {
  const match = /^([a-z0-9-]+) (devotional|study) (en|am)$/.exec(query);
  return match ? { slug: match[1], type: WORD_TYPE[match[2]], lang: match[3] } : null;
}

// t.me/<bot>?start=a_<subtopic>_<d|s>_<lang>: "Read in the bot" on a shared card.
// Subtopic slugs use hyphens only, and the longest fits the 64-character limit.
function startParam(subtopic, type, lang) {
  return `a_${subtopic.slug}_${TYPE_CODE[type]}_${lang}`;
}

export function parseStartParam(param) {
  const match = /^a_([a-z0-9-]+)_([ds])_(en|am)$/.exec(String(param || ''));
  return match ? { slug: match[1], type: CODE_TYPE[match[2]], lang: match[3] } : null;
}

// Positions of a subtopic by slug, for the screens that address content by index.
export function locateSubtopic(catalog, slug) {
  for (const [ti, theme] of catalog.themes.entries()) {
    const si = theme.subtopics.findIndex((subtopic) => subtopic.slug === slug);
    if (si >= 0) return { ti, si };
  }
  return null;
}

function cardResult(theme, subtopic, type, lang, botUsername) {
  const title = pick(subtopic.title, lang);
  const description = pick(subtopic.description, lang);
  const typeLabel = t(lang, type);
  const html = [
    `<b>${escapeHtml(title)}</b>`,
    `<i>${escapeHtml(pick(theme.title, lang))} · ${escapeHtml(typeLabel)}</i>`,
    description ? escapeHtml(clip(description, 700)) : '',
  ].filter(Boolean).join('\n\n');
  const buttons = {
    inline_keyboard: [
      [{ text: t(lang, 'readInBot'), url: `https://t.me/${botUsername}?start=${startParam(subtopic, type, lang)}` }],
      [
        { text: t(lang, 'menuSite'), url: articleWebUrl(theme, subtopic, type, lang) },
        { text: t(lang, 'shareArticle'), switch_inline_query: shareQuery(subtopic, type, lang) },
      ],
    ],
  };
  const id = `${subtopic.slug}-${TYPE_CODE[type]}-${lang}`;
  const summary = `${typeLabel} · ${t(lang, 'langName')}`;
  // A photo result must be a JPEG under 5 MB, which only the resized Cloudinary URL guarantees.
  const photo = photoUrl(pick(subtopic.covers, lang)).replace(/\.png$/i, '.jpg');
  if (photo.includes('/image/upload/c_limit,')) {
    return {
      type: 'photo',
      id,
      photo_url: photo,
      thumbnail_url: photo.replace('c_limit,w_2560,h_2560,', 'c_limit,w_320,h_320,'),
      title,
      description: summary,
      caption: html,
      parse_mode: 'HTML',
      reply_markup: buttons,
    };
  }
  return {
    type: 'article',
    id,
    title,
    description: summary,
    input_message_content: { message_text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    reply_markup: buttons,
  };
}

// The cards for an inline query: the one article a Share button names, or
// otherwise the reader's matches (everything when nothing is typed).
export async function inlineResults(query, lang, botUsername) {
  const { themes } = await getCatalog();
  const exact = parseShareQuery(query);
  if (exact) {
    for (const theme of themes) {
      const subtopic = theme.subtopics.find((entry) => entry.slug === exact.slug);
      if (subtopic?.articles[exact.type]?.[exact.lang]) return [cardResult(theme, subtopic, exact.type, exact.lang, botUsername)];
    }
    return [];
  }
  const matches = query ? searchSubtopics(themes, query) : themes.flatMap((theme, ti) => theme.subtopics.map((subtopic, si) => ({ ti, si, theme, subtopic })));
  const results = [];
  for (const { theme, subtopic } of matches) {
    for (const type of ARTICLE_TYPES) {
      if (subtopic.articles[type][lang]) results.push(cardResult(theme, subtopic, type, lang, botUsername));
    }
  }
  return results.slice(0, MAX_RESULTS);
}

export async function onInlineQuery(inlineQuery) {
  const query = String(inlineQuery.query || '').trim();
  // People sharing into a chat may never have opened the bot, so they aren't recorded as users.
  const row = await db.select({ lang: users.lang }).from(users).where(eq(users.id, inlineQuery.from.id)).get();
  const lang = row?.lang || (inlineQuery.from.language_code === 'am' ? 'am' : 'en');
  let results = [];
  try {
    const me = await api.getMe();
    results = await inlineResults(query, lang, me.username);
  } catch (error) {
    console.error('inline query failed', error?.message || error);
  }
  await api.answerInlineQuery({
    inline_query_id: inlineQuery.id,
    results,
    cache_time: 60,
    is_personal: true,
    button: { text: t(lang, 'openBot'), start_parameter: 'inline' },
  });
}
