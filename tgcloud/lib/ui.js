import { api, BotApiError } from 'sdk';
import { RICH_LIMIT, TEXT_LIMIT } from './constants.js';
import { chunkText } from './format.js';

export function button(text, data, style) {
  const result = { text, callback_data: data };
  if (style) result.style = style;
  return result;
}

export function urlButton(text, url) {
  return { text, url };
}

export function keyboard(rows) {
  return { inline_keyboard: rows.filter((row) => row && row.length) };
}

// Telegram refuses edits that change nothing; that isn't an error for us.
function unchanged(error) {
  return error instanceof BotApiError && /not modified/i.test(error.description || '');
}

async function safeDelete(chatId, messageId) {
  if (!messageId) return;
  try {
    await api.deleteMessage({ chat_id: chatId, message_id: messageId });
  } catch {
    // Too old to delete or already gone.
  }
}

// Shows a navigation screen. With `from` (the message whose button was pressed)
// the screen replaces it in place when the kinds match (text→text,
// photo→photo); otherwise the old message is removed and a new one sent.
// view: { html, keyboard, photo? }
export async function show(chatId, from, view) {
  const replyMarkup = view.keyboard;
  const caption = view.html;
  if (from?.message_id) {
    try {
      if (view.photo && from.photo) {
        await api.editMessageMedia({
          chat_id: chatId,
          message_id: from.message_id,
          media: { type: 'photo', media: view.photo, caption, parse_mode: 'HTML' },
          reply_markup: replyMarkup,
        });
        return from;
      }
      if (!view.photo && from.text != null) {
        await api.editMessageText({
          chat_id: chatId,
          message_id: from.message_id,
          text: view.html,
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
          link_preview_options: { is_disabled: true },
        });
        return from;
      }
    } catch (error) {
      if (unchanged(error)) return from;
      if (!(error instanceof BotApiError)) throw error;
    }
    await safeDelete(chatId, from.message_id);
  }
  if (view.photo) {
    try {
      return await api.sendPhoto({
        chat_id: chatId,
        photo: view.photo,
        caption,
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } catch (error) {
      if (!(error instanceof BotApiError)) throw error;
      // The image URL failed; fall through to a text screen.
    }
  }
  return api.sendMessage({
    chat_id: chatId,
    text: view.html,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
    link_preview_options: { is_disabled: true },
  });
}

export function sendHtml(chatId, html, replyMarkup) {
  return api.sendMessage({
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
    link_preview_options: { is_disabled: true },
  });
}

// Sends long-form content as one rich message. If that is refused (too long,
// or a client/API without rich messages), the fallback HTML goes out as
// several plain messages and the buttons ride on the last one.
export async function sendLong(chatId, { markdown, fallbackHtml, replyMarkup }) {
  if (markdown && markdown.length <= RICH_LIMIT) {
    try {
      return await api.sendRichMessage({
        chat_id: chatId,
        rich_message: { markdown, skip_entity_detection: true },
        reply_markup: replyMarkup,
      });
    } catch (error) {
      if (!(error instanceof BotApiError)) throw error;
      console.warn('sendRichMessage failed, sending plain messages', error.description);
    }
  }
  const pieces = chunkText(fallbackHtml, TEXT_LIMIT);
  let last = null;
  for (let i = 0; i < pieces.length; i += 1) {
    last = await sendHtml(chatId, pieces[i], i === pieces.length - 1 ? replyMarkup : undefined);
  }
  return last;
}

export async function answer(query, text, alert = false) {
  try {
    await api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: alert });
  } catch {
    // The query is older than Telegram allows answering.
  }
}

export async function react(chatId, messageId, emoji) {
  try {
    await api.setMessageReaction({
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  } catch {
    // Reactions are a nicety.
  }
}

export async function clearButtons(chatId, messageId) {
  if (!messageId) return;
  try {
    await api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  } catch {
    // Already gone or unchanged.
  }
}

export async function editButtons(chatId, messageId, replyMarkup) {
  if (!messageId) return;
  try {
    await api.editMessageReplyMarkup({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  } catch (error) {
    if (!(error instanceof BotApiError)) throw error;
    // Old messages may no longer be editable; the saved bookmark still works.
  }
}

export async function editHtml(chatId, messageId, html, replyMarkup) {
  if (!messageId) return;
  try {
    await api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    });
  } catch {
    // Already gone or unchanged.
  }
}
