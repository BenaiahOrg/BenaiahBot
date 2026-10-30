import { api, EndpointError } from 'sdk';
import { ARTICLE_TYPES, LANGS } from '../lib/constants.js';
import { articleWebUrl, getCatalog, pick } from '../lib/content.js';
import { escapeHtml } from '../lib/format.js';
import { t } from '../lib/i18n.js';

// Available to every verified Mini App user. The client cannot supply a link,
// HTML, or recipient ID: all message content is derived from the public catalog.
export default async function (input, ctx) {
  const uiLang = input.uiLang === 'am' ? 'am' : 'en';
  const userId = ctx?.initData?.user?.id;
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new EndpointError(t(uiLang, 'shareOpenFromBot'), { code: 'FORBIDDEN' });
  if (!ARTICLE_TYPES.includes(input.type) || !LANGS.includes(input.lang)) {
    throw new EndpointError(t(uiLang, 'shareNotAvailable'), { code: 'INVALID' });
  }
  const { themes } = await getCatalog();
  const theme = themes.find((entry) => entry.slug === input.theme);
  const subtopic = theme?.subtopics.find((entry) => entry.slug === input.subtopic);
  if (!subtopic?.articles[input.type][input.lang]) throw new EndpointError(t(uiLang, 'shareNotAvailable'), { code: 'NOT_FOUND' });
  const title = pick(subtopic.title, input.lang);
  const url = articleWebUrl(theme, subtopic, input.type, input.lang);
  const result = {
    type: 'article', id: 'benaiah-article', title,
    input_message_content: {
      message_text: t(input.lang, 'articleShareText', `<a href="${escapeHtml(url)}">${escapeHtml(title)}</a>`, escapeHtml(t(input.lang, input.type))),
      parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    },
  };
  const prepared = await api.savePreparedInlineMessage({ user_id: userId, result,
    allow_user_chats: true, allow_group_chats: true, allow_channel_chats: true, allow_bot_chats: false });
  return { id: prepared.id, expiresAt: prepared.expiration_date, title, ui: t(uiLang, 'sharingUi') };
}
