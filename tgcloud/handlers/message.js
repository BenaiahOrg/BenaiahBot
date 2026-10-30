import { onMessage } from '../lib/bot.js';

export default function message(message) {
  return onMessage(message);
}
