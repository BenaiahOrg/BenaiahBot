import { onCallback } from '../lib/bot.js';

export default function callbackQuery(query) {
  return onCallback(query);
}
