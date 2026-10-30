import { api, db, BotApiError } from 'sdk';
import { events } from '../schema.js';
import { brandAssets } from './brand.js';
import { findBookmark, listBookmarks } from './bookmarks.js';
import { WEBAPP_URL } from './secrets.js';
import { ARTICLE_TYPES, SEARCH_RESULTS, SITE_URL, SOCIAL_LINKS, SUBTOPICS_PER_PAGE, TEAM, WELCOME_PHOTO } from './constants.js';
import {
  articleWebUrl, audioUrl, findSubtopic, getArticle, getCatalog, searchSubtopics, getSubtopicDetail, personName, personRole, pick, telegramPost,
} from './content.js';
import { shareButton } from './share.js';
import { fileName, photoUrl, sendAlbum, sendOriginals } from './files.js';
import { clip, escapeHtml, markdownToHtml } from './format.js';
import { t } from './i18n.js';
import { button, keyboard, sendHtml, sendLong, show, urlButton } from './ui.js';

const TYPE_CODE = { devotional: 'd', study_material: 's' };
const CODE_TYPE = { d: 'devotional', s: 'study_material' };

export function typeFromCode(code) {
  return CODE_TYPE[code] || null;
}

export async function logEvent(userId, kind, key = '', lang = '') {
  try {
    await db.insert(events).values({ userId, kind, key, lang, createdAt: Date.now() }).run();
  } catch (error) {
    console.error('Could not log an event', error?.message || error);
  }
}

export function langChooser() {
  return {
    html: t('en', 'chooseLang'),
    keyboard: keyboard([[button('🇬🇧 English', 'L:en'), button('🇪🇹 አማርኛ', 'L:am')]]),
  };
}

// The welcome is a photo of the logo with the text as its caption.
// `notice` (HTML) goes above the welcome text, e.g. "Your request was cancelled."
// Admins get an extra row for broadcasting and the dashboard.
export function mainMenu(lang, notice, { admin = false } = {}) {
  return {
    html: notice ? `${notice}\n\n${t(lang, 'welcome')}` : t(lang, 'welcome'),
    photo: WEBAPP_URL ? `${WEBAPP_URL.replace(/\/$/, '')}${WELCOME_PHOTO}` : undefined,
    keyboard: keyboard([
      [button(t(lang, 'menuThemes'), 'T', 'primary')],
      [button(t(lang, 'menuRandom'), 'R'), button(t(lang, 'menuSearch'), 'S')],
      [button(t(lang, 'menuCounsel'), 'C')],
      [button(t(lang, 'menuBookmarks'), 'BM:0')],
      [button(t(lang, 'menuAbout'), 'A')],
      [button(t(lang, 'menuLang'), 'G'), urlButton(t(lang, 'menuSite'), SITE_URL)],
      admin ? [button(t(lang, 'menuBroadcast'), 'BC'), ...(WEBAPP_URL ? [{ text: t(lang, 'dashboard'), web_app: { url: WEBAPP_URL } }] : [])] : null,
    ]),
  };
}

export function aboutView(lang) {
  return {
    html: t(lang, 'about'),
    keyboard: keyboard([
      [button(t(lang, 'aboutMission'), 'A:m'), button(t(lang, 'aboutName'), 'A:o')],
      [button(t(lang, 'aboutHow'), 'A:w'), button(t(lang, 'aboutTeam'), 'A:t')],
      [button(t(lang, 'menuBrand'), 'B'), button(t(lang, 'aboutContact'), 'A:c')],
      [button(t(lang, 'aboutFeedback'), 'A:f')],
      [urlButton(t(lang, 'aboutChannel'), SOCIAL_LINKS.channel), urlButton(t(lang, 'aboutApp'), SOCIAL_LINKS.app)],
      [button(t(lang, 'home'), 'M')],
    ]),
  };
}

const ABOUT_PAGES = { m: 'pageMission', o: 'pageName', w: 'pageHow' };

// One of the About sub-pages: mission, name, work, team, contact or feedback.
export function aboutPage(lang, page) {
  const nav = [button(t(lang, 'back'), 'A'), button(t(lang, 'home'), 'M')];
  if (page === 'f') {
    return {
      html: t(lang, 'pageFeedback'),
      keyboard: keyboard([
        [urlButton(t(lang, 'reportBug'), `${SOCIAL_LINKS.contact}?text=${encodeURIComponent(t(lang, 'bugReportDraft'))}`)],
        [urlButton(t(lang, 'requestFeature'), `${SOCIAL_LINKS.contact}?text=${encodeURIComponent(t(lang, 'featureRequestDraft'))}`)],
        nav,
      ]),
    };
  }
  if (page === 't') {
    const roles = t(lang, 'teamRoles');
    const lines = Object.entries(TEAM).map(([role, names]) => `<b>${escapeHtml(roles[role])}</b>\n${names.map(escapeHtml).join(' · ')}`);
    return { html: t(lang, 'pageTeam', lines.join('\n\n')), keyboard: keyboard([nav]) };
  }
  if (page === 'c') {
    return {
      html: t(lang, 'pageContact'),
      keyboard: keyboard([
        [urlButton('💬 Telegram', SOCIAL_LINKS.contact), urlButton(t(lang, 'aboutChannel'), SOCIAL_LINKS.channel)],
        [urlButton('Instagram', SOCIAL_LINKS.instagram), urlButton('Facebook', SOCIAL_LINKS.facebook)],
        [urlButton('X', SOCIAL_LINKS.x), urlButton('Threads', SOCIAL_LINKS.threads), urlButton('LinkedIn', SOCIAL_LINKS.linkedin)],
        [urlButton(t(lang, 'menuSite'), SITE_URL)],
        nav,
      ]),
    };
  }
  return { html: t(lang, ABOUT_PAGES[page] || 'about'), keyboard: keyboard([nav]) };
}

// The logo as a photo album, then the original files uncompressed.
export async function sendBrand(chatId, lang) {
  const assets = await brandAssets();
  await sendAlbum(chatId, assets.filter((a) => a.photo).map((a) => a.url), t(lang, 'brandCaption'));
  await sendOriginals(chatId, assets.map((a) => ({ url: a.url, name: a.name })));
  return sendHtml(chatId, t(lang, 'brandFiles'), keyboard([[button(t(lang, 'menuAbout'), 'A:n'), button(t(lang, 'home'), 'M:n')]]));
}

export function errorView(lang) {
  return { html: t(lang, 'loadError'), keyboard: keyboard([[button(t(lang, 'home'), 'M')]]) };
}

export async function themesView(lang) {
  const { themes } = await getCatalog();
  return {
    html: t(lang, 'themesTitle'),
    keyboard: keyboard([
      ...themes.map((theme, ti) => [button(`${pick(theme.title, lang)} · ${t(lang, 'topicCount', theme.subtopics.length)}`, `t:${ti}:0`)]),
      [button(t(lang, 'home'), 'M')],
    ]),
  };
}

export async function themeView(lang, ti, page) {
  const { themes } = await getCatalog();
  const theme = themes[ti];
  if (!theme) return themesView(lang);
  const pages = Math.max(1, Math.ceil(theme.subtopics.length / SUBTOPICS_PER_PAGE));
  const current = Math.min(Math.max(page, 0), pages - 1);
  const start = current * SUBTOPICS_PER_PAGE;
  const slice = theme.subtopics.slice(start, start + SUBTOPICS_PER_PAGE);
  const rows = [];
  for (let i = 0; i < slice.length; i += 2) {
    rows.push(slice.slice(i, i + 2).map((subtopic, j) => button(pick(subtopic.title, lang), `s:${ti}:${start + i + j}`)));
  }
  if (pages > 1) {
    rows.push([
      current > 0 ? button(t(lang, 'prev'), `t:${ti}:${current - 1}`) : button(' ', 'noop'),
      button(`${current + 1}/${pages}`, 'noop'),
      current < pages - 1 ? button(t(lang, 'next'), `t:${ti}:${current + 1}`) : button(' ', 'noop'),
    ]);
  }
  rows.push([button(t(lang, 'back'), 'T'), button(t(lang, 'home'), 'M')]);
  return {
    html: t(lang, 'themeTitle', escapeHtml(pick(theme.title, lang)), theme.subtopics.length),
    keyboard: keyboard(rows),
  };
}

function subtopicKeyboard(lang, ti, si, subtopic) {
  const has = (type) => Boolean(subtopic.articles[type].en || subtopic.articles[type].am);
  const articleButtons = ARTICLE_TYPES.filter(has).map((type) => button(t(lang, type), `v:${ti}:${si}:${TYPE_CODE[type]}:${lang}`, 'primary'));
  return keyboard([
    articleButtons,
    [button(t(lang, 'credits'), `c:${ti}:${si}`)],
    [button(t(lang, 'back'), `t:${ti}:${Math.floor(si / SUBTOPICS_PER_PAGE)}`), button(t(lang, 'home'), 'M')],
  ]);
}

export async function subtopicView(lang, ti, si) {
  const catalog = await getCatalog();
  const found = findSubtopic(catalog, ti, si);
  if (!found) return themesView(lang);
  const { theme, subtopic } = found;
  const html = [
    `<b>${escapeHtml(pick(subtopic.title, lang))}</b>`,
    `<i>${escapeHtml(pick(theme.title, lang))}</i>`,
    '',
    escapeHtml(clip(pick(subtopic.description, lang), 700)),
  ].join('\n');
  return {
    html,
    photo: photoUrl(pick(subtopic.covers, lang)) || undefined,
    keyboard: subtopicKeyboard(lang, ti, si, subtopic),
  };
}

function articleLanguage(subtopic, type, preferred) {
  if (subtopic.articles[type]?.[preferred]) return preferred;
  const other = preferred === 'am' ? 'en' : 'am';
  return subtopic.articles[type]?.[other] ? other : null;
}

async function articleBookmarkButton(lang, userId, ti, si, theme, subtopic, type, articleLang, fresh = false) {
  if (!userId) return null;
  const saved = await findBookmark(userId, theme.slug, subtopic.slug, type, articleLang);
  return button(t(lang, saved ? 'removeBookmark' : 'saveBookmark'),
    `${saved ? 'bu' : 'bs'}:${ti}:${si}:${TYPE_CODE[type]}:${articleLang}${fresh ? ':n' : ''}`);
}

export async function bookmarksView(userId, lang, page = 0) {
  const saved = await listBookmarks(userId, page);
  const rows = saved.rows.map((row) => [
    button(`${clip(row.title, 45)} · ${t(lang, row.articleType)} · ${t(row.lang, 'langName')}`, `bo:${row.id}`),
    button(t(lang, 'deleteBookmark'), `bd:${row.id}:${saved.page}`),
  ]);
  if (saved.pages > 1) rows.push([
    saved.page > 0 ? button(t(lang, 'prev'), `BM:${saved.page - 1}`) : button(' ', 'noop'),
    button(`${saved.page + 1}/${saved.pages}`, 'noop'),
    saved.page < saved.pages - 1 ? button(t(lang, 'next'), `BM:${saved.page + 1}`) : button(' ', 'noop'),
  ]);
  rows.push([button(t(lang, 'home'), 'M')]);
  return { html: t(lang, saved.total ? 'bookmarksTitle' : 'bookmarksEmpty', saved.total), keyboard: keyboard(rows) };
}

function articleActions(lang, ti, si, type, readLang, subtopic, fresh = false) {
  const context = `${ti}:${si}:${TYPE_CODE[type]}:${readLang}`;
  const suffix = fresh ? ':n' : '';
  const media = subtopic.media[type][readLang];
  return [
    [button(t(lang, 'read'), `a:${context}${suffix}`, 'primary')],
    [
      graphicSet(subtopic, readLang, 'q').length ? button(t(lang, 'graphics'), `g:${ti}:${si}:q:${TYPE_CODE[type]}:${readLang}${suffix}`) : null,
      graphicSet(subtopic, readLang, 'y').length ? button(t(lang, 'story'), `g:${ti}:${si}:y:${TYPE_CODE[type]}:${readLang}${suffix}`) : null,
    ].filter(Boolean),
    [
      media.video ? button(t(lang, 'watchVideo'), `av:${context}:v${suffix}`) : null,
      media.short ? button(t(lang, 'watchShort'), `av:${context}:s${suffix}`) : null,
    ].filter(Boolean),
    media.narration ? [button(t(lang, 'listenNarration'), `an:${context}${suffix}`)] : null,
  ];
}

// Choose the article type first, then offer only its own language's media.
export async function articleView(lang, ti, si, type, articleLang, userId) {
  const found = findSubtopic(await getCatalog(), ti, si);
  if (!found) return themesView(lang);
  const { theme, subtopic } = found;
  const readLang = articleLanguage(subtopic, type, articleLang);
  if (!readLang) return { html: t(lang, 'notAvailable'), keyboard: keyboard([[button(t(lang, 'back'), `s:${ti}:${si}`)]]) };
  const otherLang = readLang === 'en' ? 'am' : 'en';
  return {
    html: [
      `<b>${escapeHtml(pick(subtopic.title, readLang))}</b>`,
      `<i>${escapeHtml(pick(theme.title, readLang))} · ${t(lang, type)} · ${t(readLang, 'langName')}</i>`,
      t(lang, 'chooseFormat'),
    ].join('\n\n'),
    photo: photoUrl(pick(subtopic.covers, readLang)) || undefined,
    keyboard: keyboard([
      ...articleActions(lang, ti, si, type, readLang, subtopic),
      [shareButton(lang, subtopic, type, readLang),
        await articleBookmarkButton(lang, userId, ti, si, theme, subtopic, type, readLang)].filter(Boolean),
      subtopic.articles[type][otherLang] ? [button(t(readLang, 'readIn'), `v:${ti}:${si}:${TYPE_CODE[type]}:${otherLang}`)] : null,
      [button(t(lang, 'back'), `s:${ti}:${si}`), button(t(lang, 'home'), 'M')],
    ]),
  };
}

export async function sendArticleMedia(chatId, lang, ti, si, type, articleLang, kind) {
  const found = findSubtopic(await getCatalog(), ti, si);
  if (!found) return sendHtml(chatId, t(lang, 'loadError'));
  const { subtopic } = found;
  const back = [button(t(lang, 'back'), `v:${ti}:${si}:${TYPE_CODE[type]}:${articleLang}:n`), button(t(lang, 'home'), 'M:n')];
  const url = subtopic.articles[type]?.[articleLang] && subtopic.media[type][articleLang]?.[kind];
  if (!url) return sendHtml(chatId, t(lang, 'noMedia'), keyboard([back]));
  const label = `${t(lang, kind === 'narration' ? 'listenNarration' : kind === 'short' ? 'watchShort' : 'watchVideo')} — <b>${escapeHtml(pick(subtopic.title, articleLang))}</b> · ${t(lang, type)}`;
  if (kind === 'narration') {
    try {
      await api.forwardMessage({ chat_id: chatId, ...telegramPost(url) });
    } catch (error) {
      if (!(error instanceof BotApiError)) throw error;
      return sendHtml(chatId, t(lang, 'narrationUnavailable'), keyboard([
        [urlButton(t(lang, 'listenNarration'), url)], back,
      ]));
    }
    return sendHtml(chatId, label, keyboard([back]));
  }
  // YouTube watch/Short URLs aren't video files that sendVideo can upload.
  return api.sendMessage({
    chat_id: chatId,
    text: `${label}\n\n${escapeHtml(url)}`,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: false, url, prefer_large_media: true },
    reply_markup: keyboard([[urlButton(t(lang, kind === 'short' ? 'watchShort' : 'watchVideo'), url)], back]),
  });
}

function peopleLine(people, lang) {
  return people.map((person) => {
    const name = personName(person, lang);
    const role = personRole(person, lang);
    return role ? `${name} (${role})` : name;
  }).filter(Boolean).join(', ');
}

export async function creditsView(lang, ti, si) {
  const catalog = await getCatalog();
  const found = findSubtopic(catalog, ti, si);
  if (!found) return themesView(lang);
  const { theme, subtopic } = found;
  const detail = await getSubtopicDetail(theme.slug, subtopic.slug);
  const lines = [t(lang, 'creditsTitle', escapeHtml(pick(subtopic.title, lang))), ''];
  for (const type of ARTICLE_TYPES) {
    for (const articleLang of ['en', 'am']) {
      const people = detail.authors[`${type}_${articleLang}`] || [];
      if (!people.length) continue;
      lines.push(`<b>${t(lang, type)} · ${t(articleLang, 'langName')}</b>\n${escapeHtml(peopleLine(people, lang))}`);
    }
  }
  if (detail.artists.length) lines.push(`<b>${t(lang, 'team')}</b>\n${escapeHtml(peopleLine(detail.artists, lang))}`);
  const html = lines.join('\n\n');
  return {
    html,
    // A photo caption holds 1024 characters; longer credits become a text screen.
    photo: html.length <= 1024 ? photoUrl(pick(subtopic.covers, lang)) || undefined : undefined,
    keyboard: keyboard([[button(t(lang, 'back'), `s:${ti}:${si}`), button(t(lang, 'home'), 'M')]]),
  };
}

// Sends an article as a new message. `articleLang` may differ from the UI
// language when the user asks for the other translation.
export async function sendArticle(chatId, lang, ti, si, type, articleLang, userId = chatId) {
  const catalog = await getCatalog();
  const found = findSubtopic(catalog, ti, si);
  if (!found) return sendHtml(chatId, t(lang, 'loadError'));
  const { theme, subtopic } = found;
  const otherLang = articleLang === 'en' ? 'am' : 'en';
  let readLang = articleLang;
  if (!subtopic.articles[type][readLang]) {
    if (!subtopic.articles[type][otherLang]) return sendHtml(chatId, t(lang, 'notAvailable'));
    await sendHtml(chatId, t(readLang, 'notAvailable'));
    readLang = otherLang;
  }
  const [article, detail] = await Promise.all([
    getArticle(subtopic.articles[type][readLang]),
    getSubtopicDetail(theme.slug, subtopic.slug).catch(() => ({ authors: {}, artists: [] })),
  ]);
  if (!article?.content) return sendHtml(chatId, t(lang, 'loadError'));

  const authors = peopleLine(detail.authors[`${type}_${readLang}`] || [], readLang);
  const listen = audioUrl(article.audio);
  const meta = [pick(theme.title, readLang), pick(subtopic.title, readLang), article.date].filter(Boolean).join(' · ');
  const title = article.title || pick(subtopic.title, readLang);

  const markdown = [
    `# ${title}`,
    article.header ? `**${article.header}**` : '',
    `*${meta}*`,
    article.content.trim(),
    '---',
    authors ? `✍️ ${t(readLang, 'writtenBy')}: ${authors}` : '',
    listen ? `[${t(readLang, 'listen')}](${listen})` : '',
  ].filter(Boolean).join('\n\n');

  const fallbackHtml = [
    `<b>${escapeHtml(title)}</b>`,
    article.header ? `<b>${escapeHtml(article.header)}</b>` : '',
    `<i>${escapeHtml(meta)}</i>`,
    markdownToHtml(article.content),
    authors ? `✍️ ${escapeHtml(t(readLang, 'writtenBy'))}: ${escapeHtml(authors)}` : '',
    listen ? `<a href="${escapeHtml(listen)}">${escapeHtml(t(readLang, 'listen'))}</a>` : '',
  ].filter(Boolean).join('\n\n');

  const otherType = ARTICLE_TYPES.find((other) => other !== type);
  const rows = articleActions(lang, ti, si, type, readLang, subtopic, true).slice(1);
  if (subtopic.articles[type][readLang === 'en' ? 'am' : 'en']) {
    rows.push([button(t(readLang, 'readIn'), `v:${ti}:${si}:${TYPE_CODE[type]}:${readLang === 'en' ? 'am' : 'en'}:n`)]);
  }
  if (subtopic.articles[otherType][readLang] || subtopic.articles[otherType][lang]) {
    rows.push([button(t(lang, otherType), `v:${ti}:${si}:${TYPE_CODE[otherType]}:${lang}:n`)]);
  }
  rows.push([button(t(lang, 'back'), `v:${ti}:${si}:${TYPE_CODE[type]}:${readLang}:n`), button(t(lang, 'home'), 'M:n')]);
  rows.push([
    shareButton(lang, subtopic, type, readLang),
    await articleBookmarkButton(lang, userId, ti, si, theme, subtopic, type, readLang, true),
  ].filter(Boolean));
  rows.push([
    urlButton(t(lang, 'menuSite'), articleWebUrl(theme, subtopic, type, readLang)),
  ]);

  return sendLong(chatId, { markdown, fallbackHtml, replyMarkup: keyboard(rows) });
}

function graphicSet(subtopic, lang, kind) {
  const set = kind === 'y' ? subtopic.story : subtopic.square;
  return set[lang].length ? set[lang] : set.en.length ? set.en : set.am;
}

// Sends a subtopic's square or story graphics as a photo album (resized, so
// Telegram accepts them), then a message with navigation and a button for the
// uncompressed originals.
export async function sendGraphics(chatId, lang, ti, si, kind, type, articleLang = lang) {
  const catalog = await getCatalog();
  const found = findSubtopic(catalog, ti, si);
  if (!found) return sendHtml(chatId, t(lang, 'loadError'));
  const { subtopic } = found;
  const urls = graphicSet(subtopic, articleLang, kind);
  const context = type ? `:${TYPE_CODE[type]}:${articleLang}` : '';
  const back = [button(t(lang, 'back'), type ? `v:${ti}:${si}:${TYPE_CODE[type]}:${articleLang}:n` : `s:${ti}:${si}:n`), button(t(lang, 'home'), 'M:n')];
  if (!urls.length) return sendHtml(chatId, t(lang, 'noGraphics'), keyboard([back]));
  try {
    await sendAlbum(chatId, urls);
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    // Telegram couldn't fetch an image; the originals button still works.
    console.warn('graphics album failed', error.description);
  }
  const label = `${kind === 'y' ? t(lang, 'story') : t(lang, 'graphics')} — <b>${escapeHtml(pick(subtopic.title, articleLang))}</b>`;
  return sendHtml(chatId, kind === 'y' ? `${label}\n${t(lang, 'storyHint')}` : label, keyboard([
    [button(t(lang, 'downloadOriginals'), `gd:${ti}:${si}:${kind}${context}`, 'primary')],
    back,
  ]));
}

export async function sendGraphicOriginals(chatId, lang, ti, si, kind, type, articleLang = lang) {
  const catalog = await getCatalog();
  const found = findSubtopic(catalog, ti, si);
  if (!found) return sendHtml(chatId, t(lang, 'loadError'));
  const { subtopic } = found;
  const urls = graphicSet(subtopic, articleLang, kind);
  const prefix = `${subtopic.slug}-${kind === 'y' ? 'story' : 'square'}`;
  await sendOriginals(chatId, urls.map((url, n) => ({ url, name: `${prefix}-${n + 1}.${fileName(url, 'x.png').split('.').pop()}` })));
  return sendHtml(chatId, t(lang, 'originalsReady'), keyboard([[button(t(lang, 'back'), type ? `v:${ti}:${si}:${TYPE_CODE[type]}:${articleLang}:n` : `s:${ti}:${si}:n`), button(t(lang, 'home'), 'M:n')]]));
}

export async function randomDevotional(lang) {
  const { themes } = await getCatalog();
  const choices = [];
  themes.forEach((theme, ti) => theme.subtopics.forEach((subtopic, si) => {
    if (subtopic.articles.devotional[lang]) choices.push({ ti, si });
  }));
  if (!choices.length) return null;
  return choices[Math.floor(Math.random() * choices.length)];
}

export async function searchView(lang, query) {
  const { themes } = await getCatalog();
  const results = searchSubtopics(themes, query);
  const safe = escapeHtml(clip(query, 60));
  if (!results.length) {
    return {
      html: t(lang, 'searchNone', safe),
      keyboard: keyboard([[button(t(lang, 'menuSearch'), 'S'), button(t(lang, 'home'), 'M')]]),
    };
  }
  return {
    html: t(lang, 'searchResults', safe),
    keyboard: keyboard([
      ...results.slice(0, SEARCH_RESULTS).map(({ ti, si, theme, subtopic }) => [
        button(`${pick(subtopic.title, lang)} · ${pick(theme.title, lang)}`, `s:${ti}:${si}`),
      ]),
      [button(t(lang, 'menuSearch'), 'S'), button(t(lang, 'home'), 'M')],
    ]),
  };
}
