import { statsText } from './admin.js';
import {
  acceptOffer, cancelRequest, counselorPanel, declineOffer, introView, rate, requestCounseling, routeMessage,
  setCounselorActive, sweep, userLeft,
} from './counseling.js';
import { findSubtopic, getCatalog } from './content.js';
import { escapeHtml } from './format.js';
import { t } from './i18n.js';
import { WEBAPP_URL } from './secrets.js';
import { setupAdmin, setupIfNeeded } from './setup.js';
import { answer, button, editHtml, keyboard, sendHtml, show } from './ui.js';
import { counselorByUser, isAdmin, linkCounselor, markBlocked, setLang, setState, touchUser } from './users.js';
import {
  aboutPage, aboutView, creditsView, errorView, langChooser, logEvent, mainMenu, randomDevotional, searchView, sendArticle,
  sendBrand, sendGraphicOriginals, sendGraphics, subtopicView, themesView, themeView, typeFromCode,
} from './views.js';

function menuFor(user, lang, notice) {
  return mainMenu(lang, notice, { admin: isAdmin(user.id) });
}

function parseCommand(text) {
  const match = /^\/([a-z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/i.exec(String(text || '').trim());
  return match ? { name: match[1].toLowerCase(), arg: (match[2] || '').trim() } : null;
}

async function safely(label, work) {
  try {
    await work();
  } catch (error) {
    console.error(`${label} failed`, error?.message || error);
  }
}

// Shared by messages and callbacks: who is this, and is anything due.
async function prepare(from) {
  const user = await touchUser(from);
  const linked = await linkCounselor(from);
  if (linked) await safely('counselor welcome', () => sendHtml(from.id, t(user.lang || 'en', 'counselorWelcome')));
  await safely('sweep', sweep);
  return user;
}

function subtopicKey(catalog, ti, si) {
  const found = findSubtopic(catalog, ti, si);
  return found ? `${found.theme.slug}/${found.subtopic.slug}` : '';
}

async function openArticle(chatId, user, lang, ti, si, type, articleLang) {
  await sendArticle(chatId, lang, ti, si, type, articleLang);
  const catalog = await getCatalog();
  await logEvent(user.id, 'article', `${subtopicKey(catalog, ti, si)}/${type}_${articleLang}`, articleLang);
}

async function sendRandom(chatId, user, lang) {
  const pick = await randomDevotional(lang);
  if (!pick) return show(chatId, null, errorView(lang));
  await logEvent(user.id, 'random', '', lang);
  return openArticle(chatId, user, lang, pick.ti, pick.si, 'devotional', lang);
}

async function dashboardButton(chatId, lang) {
  if (!WEBAPP_URL) return sendHtml(chatId, t(lang, 'dashboardMissing'));
  return sendHtml(chatId, t(lang, 'dashboardIntro'), keyboard([[{ text: t(lang, 'dashboard'), web_app: { url: WEBAPP_URL } }]]));
}

async function onCommand(message, user, command) {
  const chatId = message.chat.id;
  const lang = user.lang || 'en';
  if (command.name !== 'search') await setState(user.id, '');
  switch (command.name) {
    case 'start':
      if (isAdmin(user.id)) {
        await safely('setup', setupIfNeeded);
        await safely('admin setup', () => setupAdmin(user.id));
      }
      return show(chatId, null, user.lang ? menuFor(user, lang) : langChooser());
    case 'menu':
      return show(chatId, null, menuFor(user, lang));
    case 'language':
      return show(chatId, null, langChooser());
    case 'themes':
      return show(chatId, null, await themesView(lang));
    case 'random':
      return sendRandom(chatId, user, lang);
    case 'search':
      if (command.arg) return runSearch(chatId, user, lang, command.arg);
      await setState(user.id, 'search');
      return show(chatId, null, { html: t(lang, 'searchPrompt'), keyboard: keyboard([[button(t(lang, 'home'), 'M')]]) });
    case 'counsel':
      return show(chatId, null, introView(lang));
    case 'help':
    case 'about':
      return show(chatId, null, aboutView(lang));
    case 'counselor': {
      const counselor = await counselorByUser(user.id);
      if (!counselor) return sendHtml(chatId, t(lang, 'notCounselor'));
      return show(chatId, null, await counselorPanel(counselor, lang));
    }
    case 'admin':
      if (!isAdmin(user.id)) return sendHtml(chatId, t(lang, 'adminOnly'));
      return dashboardButton(chatId, lang);
    case 'stats':
      if (!isAdmin(user.id)) return sendHtml(chatId, t(lang, 'adminOnly'));
      return sendHtml(chatId, await statsText());
    default:
      return show(chatId, null, user.lang ? menuFor(user, lang) : langChooser());
  }
}

async function runSearch(chatId, user, lang, query) {
  await setState(user.id, '');
  await logEvent(user.id, 'search', query.slice(0, 80), lang);
  return show(chatId, null, await searchView(lang, query));
}

export async function onMessage(message) {
  if (message.chat?.type !== 'private' || !message.from || message.from.is_bot) return;
  const user = await prepare(message.from);
  const chatId = message.chat.id;
  const lang = user.lang || 'en';
  try {
    if (await routeMessage(message, user)) return;
    const command = parseCommand(message.text);
    if (command) return await onCommand(message, user, command);
    if (!user.lang) return await show(chatId, null, langChooser());
    if (user.state === 'search' && message.text) return await runSearch(chatId, user, lang, message.text);
    return await show(chatId, null, menuFor(user, lang));
  } catch (error) {
    console.error('message failed', error?.stack || error);
    await safely('error reply', () => show(chatId, null, errorView(lang)));
  }
}

// Callback data is short codes (Telegram allows 64 bytes). A trailing ":n"
// means the button sits under an article or album, which must stay put, so the
// next screen is sent as a new message instead of replacing that one.
export async function onCallback(query) {
  const from = query.from;
  const chatId = query.message?.chat?.id ?? from.id;
  const user = await prepare(from);
  const lang = user.lang || 'en';
  let parts = String(query.data || '').split(':');
  const fresh = parts[parts.length - 1] === 'n';
  if (fresh) parts = parts.slice(0, -1);
  const [code, a, b, c, d] = parts;
  const target = fresh ? null : query.message;
  const ti = Number(a);
  const si = Number(b);
  let answered = false;
  const reply = async (text, alert) => {
    answered = true;
    await answer(query, text, alert);
  };

  try {
    switch (code) {
      case 'L': {
        const chosen = a === 'am' ? 'am' : 'en';
        await setLang(user.id, chosen);
        await reply(t(chosen, 'langName'));
        await show(chatId, target, menuFor(user, chosen));
        break;
      }
      case 'G':
        await show(chatId, target, langChooser());
        break;
      case 'M':
        await setState(user.id, '');
        await show(chatId, target, menuFor(user, lang));
        break;
      case 'A':
        await show(chatId, target, a ? aboutPage(lang, a) : aboutView(lang));
        break;
      case 'B':
        await reply(t(lang, 'preparing'));
        await sendBrand(chatId, lang);
        await logEvent(user.id, 'brand', '', lang);
        break;
      case 'T':
        await show(chatId, target, await themesView(lang));
        break;
      case 't':
        await show(chatId, target, await themeView(lang, ti, Number(b) || 0));
        break;
      case 's':
        await reply();
        await show(chatId, target, await subtopicView(lang, ti, si));
        await logEvent(user.id, 'subtopic', subtopicKey(await getCatalog(), ti, si), lang);
        break;
      case 'c':
        await show(chatId, target, await creditsView(lang, ti, si));
        break;
      case 'a': {
        const type = typeFromCode(c);
        if (!type) break;
        await reply();
        await openArticle(chatId, user, lang, ti, si, type, d === 'am' ? 'am' : 'en');
        break;
      }
      case 'g':
        await reply();
        await sendGraphics(chatId, lang, ti, si, c === 'y' ? 'y' : 'q');
        await logEvent(user.id, 'graphics', `${subtopicKey(await getCatalog(), ti, si)}/${c === 'y' ? 'story' : 'square'}`, lang);
        break;
      case 'gd':
        await reply(t(lang, 'preparing'));
        await sendGraphicOriginals(chatId, lang, ti, si, c === 'y' ? 'y' : 'q');
        await logEvent(user.id, 'download', `${subtopicKey(await getCatalog(), ti, si)}/${c === 'y' ? 'story' : 'square'}`, lang);
        break;
      case 'R':
        await reply();
        await sendRandom(chatId, user, lang);
        break;
      case 'S':
        await setState(user.id, 'search');
        await show(chatId, target, { html: t(lang, 'searchPrompt'), keyboard: keyboard([[button(t(lang, 'home'), 'M')]]) });
        break;
      case 'C':
        await show(chatId, target, introView(lang));
        break;
      case 'C+':
        await reply();
        if (target) await editHtml(chatId, target.message_id, t(lang, 'counselIntro'));
        await requestCounseling(user, lang);
        break;
      case 'C-': {
        await cancelRequest(user.id, Number(a));
        await reply(t(lang, 'counselCancelled'));
        await show(chatId, target, menuFor(user, lang, `<i>${escapeHtml(t(lang, 'counselCancelled'))}</i>`));
        break;
      }
      case 'o+':
        await reply(await acceptOffer(from, Number(a)));
        break;
      case 'o-':
        await reply(await declineOffer(from, Number(a)));
        break;
      case 'r':
        await rate(user.id, Number(a), Number(b));
        await reply(t(lang, 'ratingThanks'));
        await show(chatId, target, menuFor(user, lang, `<i>${escapeHtml(t(lang, 'ratingThanks'))}</i> ${'⭐'.repeat(Math.min(5, Math.max(1, Number(b) || 1)))}`));
        break;
      case 'cp':
      case 'cr': {
        const counselor = await counselorByUser(user.id);
        if (!counselor) {
          await reply(t(lang, 'notCounselor'), true);
          break;
        }
        await setCounselorActive(counselor, code === 'cr');
        await show(chatId, target, await counselorPanel({ ...counselor, active: code === 'cr' ? 1 : 0 }, lang));
        break;
      }
      default:
        break;
    }
  } catch (error) {
    console.error('callback failed', query.data, error?.stack || error);
    await safely('error reply', () => show(chatId, null, errorView(lang)));
  }
  if (!answered) await answer(query);
}

// my_chat_member: the user blocked or unblocked the bot.
export async function onMembership(update) {
  if (update.chat?.type !== 'private' || !update.from) return;
  const status = update.new_chat_member?.status;
  if (status === 'kicked') {
    await markBlocked(update.from.id, true);
    await userLeft(update.from.id);
  } else if (status === 'member') {
    await markBlocked(update.from.id, false);
  }
}

