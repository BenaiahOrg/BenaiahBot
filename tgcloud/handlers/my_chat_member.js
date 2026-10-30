import { onMembership } from '../lib/bot.js';

export default function myChatMember(update) {
  return onMembership(update);
}
