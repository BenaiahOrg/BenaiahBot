// End-to-end scenarios against the real tgcloud/ modules with a fake platform.
// Run with `npm test`. Content comes live from benaiah.org.
import assert from 'node:assert/strict';
import { migrate, rawSqlite } from './fake-db.mjs';
import { BotApiError, EndpointError, calls, failures, resetCalls } from './fake-sdk.mjs';

await import('../tgcloud/schema.js');
migrate();

const { default: onMessageHandler } = await import('../tgcloud/handlers/message.js');
const { default: onCallbackHandler } = await import('../tgcloud/handlers/callback_query.js');
const { default: onMemberHandler } = await import('../tgcloud/handlers/my_chat_member.js');
const { default: dashboardEndpoint } = await import('../tgcloud/endpoints/adminDashboard.js');
const { default: counselorEndpoint } = await import('../tgcloud/endpoints/adminCounselor.js');
const { default: saveEndpoint } = await import('../tgcloud/endpoints/adminCounselorSave.js');
const { default: setupEndpoint } = await import('../tgcloud/endpoints/setup.js');
const { chunkText, markdownToHtml } = await import('../tgcloud/lib/format.js');

const people = {
  admin: { id: 900, first_name: 'Admin', username: 'boss' },
  seeker: { id: 101, first_name: 'Abebe', username: 'abebe' },
  seeker2: { id: 102, first_name: 'Sara' },
  c1: { id: 201, first_name: 'Hana', username: 'c_one' },
  c2: { id: 202, first_name: 'Dawit', username: 'c_two' },
};

let messageId = 1;
let queryId = 1;
let passed = 0;

function from(person) {
  return { ...person, is_bot: false };
}

async function send(person, text, extra = {}) {
  resetCalls();
  const message = { message_id: messageId++, chat: { id: person.id, type: 'private' }, from: from(person), date: 0, text, ...extra };
  await onMessageHandler(message);
  return message;
}

async function press(person, data, message = { message_id: messageId++, chat: { id: person.id }, text: 'menu' }) {
  resetCalls();
  await onCallbackHandler({ id: String(queryId++), from: from(person), message, data });
}

function sent(method, chatId) {
  return calls.filter((c) => c.method === method && (chatId == null || c.params.chat_id === chatId));
}

function lastText(chatId) {
  const all = calls.filter((c) => c.params.chat_id === chatId && (c.params.text || c.params.caption || c.params.media?.caption));
  const last = all[all.length - 1];
  return last ? (last.params.text || last.params.caption || last.params.media?.caption) : '';
}

function buttons(call) {
  return (call?.params.reply_markup?.inline_keyboard || []).flat();
}

function buttonData(chatId, method) {
  const list = calls.filter((c) => c.params.chat_id === chatId && c.params.reply_markup?.inline_keyboard && (!method || c.method === method));
  return buttons(list[list.length - 1]).map((b) => b.callback_data).filter(Boolean);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✘ ${name}`);
    console.error(error);
    console.error('Last calls:', JSON.stringify(calls.slice(-6), null, 1).slice(0, 3000));
    process.exit(1);
  }
}

function query(text, params = {}) {
  return rawSqlite().prepare(text).all(params);
}

function personFor(counselorId) {
  const userId = query(`SELECT user_id FROM counselors WHERE id = ${counselorId}`)[0].user_id;
  return Object.values(people).find((p) => p.id === userId);
}

function counselorIdOf(person) {
  return query(`SELECT id FROM counselors WHERE user_id = ${person.id}`)[0].id;
}

// ── Formatting ─────────────────────────────────────────────────────────────
await test('markdown converts and long text chunks under the limit with balanced tags', () => {
  assert.equal(markdownToHtml('**Hi** *there* [x](https://a.b) <script>'), '<b>Hi</b> <i>there</i> <a href="https://a.b">x</a> &lt;script&gt;');
  const long = `<b>${'word '.repeat(1500)}</b>\n\n${'ሰላም። '.repeat(900)}`;
  const pieces = chunkText(long, 4000);
  assert.ok(pieces.length >= 3);
  for (const piece of pieces) {
    assert.ok(piece.length <= 4010, `piece too long: ${piece.length}`);
    assert.equal((piece.match(/<b>/g) || []).length, (piece.match(/<\/b>/g) || []).length);
  }
});

// ── Content browsing ──────────────────────────────────────────────────────
await test('first /start shows the language chooser', async () => {
  await send(people.seeker, '/start');
  assert.deepEqual(buttonData(101), ['L:en', 'L:am']);
});

await test('choosing Amharic shows the Amharic main menu', async () => {
  await press(people.seeker, 'L:am');
  assert.match(lastText(101), /ወደ በናያስ እንኳን በደህና መጡ/);
  assert.match(lastText(101), /እግዚአብሔር ፈጠረ/, 'the welcome explains the name');
  for (const d of ['C', 'A', 'B', 'T']) assert.ok(buttonData(101).includes(d), d);
  assert.equal(query('SELECT lang FROM users WHERE id = 101')[0].lang, 'am');
});

await test('themes list every theme from the API', async () => {
  await press(people.seeker, 'T');
  const data = buttonData(101);
  assert.ok(data.filter((d) => d.startsWith('t:')).length >= 3, data.join(','));
  assert.match(lastText(101), /ርዕሶች/);
});

await test('a theme lists its subtopics with paging', async () => {
  await press(people.seeker, 't:1:0');
  const data = buttonData(101);
  assert.ok(data.includes('s:1:0'));
  assert.ok(data.includes('t:1:1'), 'Names of God has 10 topics, so a second page');
  await press(people.seeker, 't:1:1');
  assert.ok(buttonData(101).includes('s:1:8'));
});

await test('a subtopic is a cover photo with article, graphics and credits buttons', async () => {
  await press(people.seeker, 's:1:0');
  // From a text message to a photo: the old message is replaced.
  assert.equal(sent('deleteMessage').length, 1);
  const photo = sent('sendPhoto', 101)[0];
  // Resized by Cloudinary: Telegram won't fetch photos over 5 MB by URL.
  assert.match(photo.params.photo, /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/c_limit,/);
  assert.match(photo.params.caption, /ጄሆቫ ይርኤ/);
  const data = buttons(photo).map((b) => b.callback_data);
  for (const d of ['a:1:0:d:am', 'a:1:0:s:am', 'g:1:0:q', 'g:1:0:y', 'c:1:0']) assert.ok(data.includes(d), d);
});

await test('reading an article sends one rich message with buttons to switch language and type', async () => {
  await press(people.seeker, 'a:1:0:d:am');
  const rich = sent('sendRichMessage', 101)[0];
  assert.ok(rich, 'rich message sent');
  assert.match(rich.params.rich_message.markdown, /^# /);
  assert.match(rich.params.rich_message.markdown, /ጸሐፊ: ክሊንተን በየነ/);
  const data = buttons(rich).map((b) => b.callback_data).filter(Boolean);
  assert.ok(data.includes('a:1:0:d:en:n'));
  assert.ok(data.includes('a:1:0:s:am:n'));
  assert.ok(data.includes('s:1:0:n'));
  assert.ok(buttons(rich).some((b) => b.url?.startsWith('https://www.benaiah.org/articles/themes/Names%20of%20God/')));
  assert.equal(query("SELECT count(*) AS n FROM events WHERE kind = 'article'")[0].n, 1);
});

await test('"Back" under an article sends the card as a new message instead of replacing the article', async () => {
  await press(people.seeker, 's:1:0:n', { message_id: 77, chat: { id: 101 } });
  assert.equal(sent('deleteMessage').length, 0);
  assert.equal(sent('sendPhoto', 101).length, 1);
});

await test('the longest study (13k chars, English) fits in one rich message', async () => {
  await press(people.seeker, 'a:1:3:s:en:n');
  const rich = sent('sendRichMessage', 101)[0];
  assert.ok(rich.params.rich_message.markdown.length > 12000);
});

await test('when rich messages are refused, the article goes out as plain chunks', async () => {
  failures.sendRichMessage = () => new BotApiError('sendRichMessage', 400, 'Bad Request: method not supported');
  await press(people.seeker, 'a:1:3:s:en:n');
  delete failures.sendRichMessage;
  const plain = sent('sendMessage', 101);
  assert.ok(plain.length >= 4, `chunks: ${plain.length}`);
  for (const call of plain) assert.ok(call.params.text.length <= 4096);
  assert.ok(buttons(plain[plain.length - 1]).length > 0, 'buttons ride on the last chunk');
  assert.equal(buttons(plain[0]).length, 0);
});

await test('square and story graphics both arrive as resized photo albums with a download button', async () => {
  await press(people.seeker, 'g:1:0:q');
  const album = sent('sendMediaGroup', 101)[0];
  assert.equal(album.params.media.length, 6);
  assert.ok(album.params.media.every((m) => m.type === 'photo' && m.media.includes('/upload/c_limit,')));
  assert.ok(buttonData(101).includes('s:1:0:n'));
  assert.ok(buttonData(101).includes('gd:1:0:q'));
  await press(people.seeker, 'g:1:0:y');
  const stories = sent('sendMediaGroup', 101)[0];
  assert.equal(stories.params.media.length, 3);
  assert.ok(stories.params.media.every((m) => m.type === 'photo'));
  assert.ok(buttonData(101).includes('gd:1:0:y'));
});

await test('"Download originals" sends the uncompressed files once, then reuses their file ids', async () => {
  await press(people.seeker, 'gd:1:0:y');
  const docs = sent('sendMediaGroup', 101)[0];
  assert.equal(docs.params.media.length, 3);
  for (const m of docs.params.media) {
    assert.equal(m.type, 'document');
    assert.ok(m.media.bytes.length > 5_000_000, 'the full-size PNG was uploaded');
    assert.match(m.media.name, /^jehovah-jireh-story-\d\.png$/);
  }
  assert.ok(buttonData(101).includes('s:1:0:n'));
  await press(people.seeker, 'gd:1:0:y');
  const again = sent('sendMediaGroup', 101)[0];
  assert.ok(again.params.media.every((m) => typeof m.media === 'string' && m.media.startsWith('file-')));
});

await test('About has mission, name, how we work, team and contact pages from the website', async () => {
  await press(people.seeker, 'A');
  assert.match(lastText(101), /ስለ በናያስ/);
  for (const d of ['A:m', 'A:o', 'A:w', 'A:t', 'A:c', 'B']) assert.ok(buttonData(101).includes(d), d);
  await press(people.seeker, 'A:m');
  assert.match(lastText(101), /አዲስ ይዘት፥ አንድ ተልዕኮ/);
  await press(people.seeker, 'A:o');
  assert.match(lastText(101), /ባና-ያህ/);
  await press(people.seeker, 'A:t');
  assert.match(lastText(101), /ደራሲያን<\/b>\nEden Tesfaye/);
  await press(people.seeker, 'A:c');
  assert.ok(buttons(calls.findLast((c) => c.params.reply_markup)).some((b) => b.url === 'https://instagram.com/benaiah_org'));
  for (const call of calls) if (call.params.text) assert.ok(call.params.text.length <= 4096);
});

await test('Brand assets sends the logo as photos and as original files', async () => {
  await press(people.seeker, 'B');
  const [photos, files] = sent('sendMediaGroup', 101);
  assert.equal(photos.params.media.length, 2);
  assert.match(photos.params.media[0].caption, /አርማ/);
  assert.equal(files.params.media.length, 3);
  assert.ok(files.params.media.some((m) => m.media.name === 'Benaiah-logo-transparent.png'));
});

await test('credits list authors per article and the design team', async () => {
  await press(people.seeker, 'c:1:0', { message_id: 55, chat: { id: 101 }, photo: [{}] });
  const edit = sent('editMessageMedia', 101)[0];
  assert.ok(edit, 'edited the card in place');
  assert.match(edit.params.media.caption, /ትሩኬት ለማ/);
  assert.match(edit.params.media.caption, /ምስልና ትረካ/);
});

await test('search finds Amharic and English matches and logs the query', async () => {
  await press(people.seeker, 'S');
  await send(people.seeker, 'ተስፋ');
  assert.match(lastText(101), /ውጤቶች/);
  assert.ok(buttonData(101).some((d) => d.startsWith('s:0:')));
  await send(people.seeker, '/search armor');
  assert.ok(buttonData(101).filter((d) => d.startsWith('s:2:')).length === 5);
  await send(people.seeker, '/search zzzz');
  assert.match(lastText(101), /ምንም አልተገኘም/);
  assert.equal(query("SELECT count(*) AS n FROM events WHERE kind = 'search'")[0].n, 3);
});

await test('random devotional sends an article in the reader’s language', async () => {
  await press(people.seeker, 'R');
  const rich = sent('sendRichMessage', 101)[0];
  assert.ok(rich);
  assert.match(rich.params.rich_message.markdown, /[ሀ-፿]/);
});

// ── Counselors and setup ──────────────────────────────────────────────────
await test('non-admins cannot use the dashboard endpoints', async () => {
  await assert.rejects(dashboardEndpoint({}, { initData: { user: { id: 101 } } }), EndpointError);
  await send(people.seeker, '/stats');
  assert.match(lastText(101), /አስተዳዳሪ/);
});

await test('setup registers commands, the admin menu button and seed counselors', async () => {
  resetCalls();
  const result = await setupEndpoint({}, { initData: { user: { id: 900 } } });
  assert.deepEqual(result.seeded, ['@seeded_counselor']);
  assert.ok(sent('setMyCommands').length >= 3);
  assert.equal(sent('setChatMenuButton')[0].params.menu_button.web_app.url, 'https://app1.tgcloud.ai/');
});

await test('admins add counselors by @username (linked when they open the bot) and by id', async () => {
  const ctx = { initData: { user: { id: 900 } } };
  const added = await saveEndpoint({ action: 'add', handle: '@C_One', displayName: 'Hana' }, ctx);
  assert.equal(added.linked, false);
  await assert.rejects(saveEndpoint({ action: 'add', handle: 'c_one' }, ctx), /already a counselor/);
  await assert.rejects(saveEndpoint({ action: 'add', handle: 'not valid!' }, ctx), EndpointError);
  // c1 opens the bot: linked and welcomed.
  await send(people.c1, '/start');
  assert.ok(sent('sendMessage', 201).some((c) => /counselor/.test(c.params.text)));
  await press(people.c1, 'L:en');
  // c2 has already used the bot, then is added by id: welcomed right away.
  await send(people.c2, '/start');
  await press(people.c2, 'L:en');
  resetCalls();
  const second = await saveEndpoint({ action: 'add', handle: 'https://t.me/c_two' }, ctx);
  assert.equal(second.reachable, true);
  assert.equal(second.counselors.filter((c) => c.linked).length, 2);
  // The seeded counselor never opened the bot: pause them so they don't get offers.
  const seeded = second.counselors.find((c) => c.username === 'seeded_counselor');
  await saveEndpoint({ action: 'update', id: seeded.id, active: false }, ctx);
});

// ── Counseling ────────────────────────────────────────────────────────────
let firstOfferTo;
let introMessage;
await test('requesting counseling first asks for a message; nobody is notified yet', async () => {
  await press(people.seeker, 'C');
  assert.match(lastText(101), /ሚስጥራዊ ምክር/);
  await press(people.seeker, 'C+');
  assert.match(lastText(101), /በአጭሩ ይንገሩን/);
  assert.equal(query('SELECT status FROM requests WHERE id = 1')[0].status, 'intro');
  assert.equal(query('SELECT count(*) AS n FROM offers')[0].n, 0);
  // A second press doesn't open a second request.
  await press(people.seeker, 'C+');
  assert.equal(query('SELECT count(*) AS n FROM requests')[0].n, 1);
});

await test('the first message goes to one random counselor, above the Accept/Decline offer', async () => {
  introMessage = await send(people.seeker, 'ሰላም፣ ስለ ቤተሰቤ ማውራት እፈልጋለሁ');
  const offers = query("SELECT * FROM offers WHERE status = 'pending'");
  assert.equal(offers.length, 1);
  firstOfferTo = personFor(offers[0].counselor_id);
  const copy = sent('copyMessage', firstOfferTo.id)[0];
  assert.deepEqual(copy.params, { chat_id: firstOfferTo.id, from_chat_id: 101, message_id: introMessage.message_id });
  const notice = sent('sendMessage', firstOfferTo.id)[0];
  assert.match(notice.params.text, /New anonymous counseling request #1/);
  assert.match(notice.params.text, /Their message is above/);
  assert.ok(notice.params.reply_parameters?.message_id, 'the offer replies to the copied message');
  assert.doesNotMatch(notice.params.text, /Abebe|abebe|101/, 'the counselor learns nothing about the person');
  assert.match(lastText(101), /እየፈለግን/);
  assert.equal(query('SELECT count(*) AS n FROM queued')[0].n, 0, 'the first message is not queued again');
});

await test('messages written while waiting are queued, not lost', async () => {
  await send(people.seeker, 'ቶሎ ብታገኙኝ ደስ ይለኛል');
  await send(people.seeker, 'እባካችሁ');
  assert.equal(query('SELECT count(*) AS n FROM queued')[0].n, 2);
  assert.equal(sent('setMessageReaction', 101).length, 1);
});

let secondOfferTo;
await test('a decline passes the request to the other counselor', async () => {
  const offer = query("SELECT * FROM offers WHERE status = 'pending'")[0];
  await press(firstOfferTo, `o-:${offer.id}`);
  assert.equal(query(`SELECT status FROM offers WHERE id = ${offer.id}`)[0].status, 'declined');
  secondOfferTo = firstOfferTo === people.c1 ? people.c2 : people.c1;
  assert.match(lastText(secondOfferTo.id), /request #1/);
  assert.equal(sent('copyMessage', secondOfferTo.id)[0].params.message_id, introMessage.message_id, 'the next counselor sees the first message too');
  // A stale button from the first counselor does nothing.
  await press(firstOfferTo, `o+:${offer.id}`);
  assert.equal(query("SELECT status FROM requests WHERE id = 1")[0].status, 'searching');
});

await test('accepting connects both sides and delivers the queued messages', async () => {
  const offer = query("SELECT * FROM offers WHERE status = 'pending'")[0];
  await press(secondOfferTo, `o+:${offer.id}`);
  assert.equal(query('SELECT status FROM requests WHERE id = 1')[0].status, 'active');
  const copied = sent('copyMessages', secondOfferTo.id)[0];
  assert.equal(copied.params.from_chat_id, 101);
  assert.equal(copied.params.message_ids.length, 2);
  const userNotice = sent('sendMessage', 101).find((c) => /አማካሪ ተገናኝቷል/.test(c.params.text));
  assert.ok(userNotice);
  assert.equal(userNotice.params.reply_markup.keyboard[0][0].text, '⏹ ውይይቱን ጨርስ');
  assert.equal(query('SELECT count(*) AS n FROM queued')[0].n, 0);
});

await test('messages relay anonymously both ways with copyMessage', async () => {
  const fromUser = await send(people.seeker, 'ዛሬ ከባድ ቀን ነበር');
  assert.deepEqual(sent('copyMessage')[0].params, { chat_id: secondOfferTo.id, from_chat_id: 101, message_id: fromUser.message_id });
  const voice = await send(secondOfferTo, undefined, { voice: { file_id: 'v1' } });
  assert.deepEqual(sent('copyMessage')[0].params, { chat_id: 101, from_chat_id: secondOfferTo.id, message_id: voice.message_id });
  const row = query('SELECT user_messages, counselor_messages FROM requests WHERE id = 1')[0];
  assert.equal(row.user_messages, 4, 'first message + 2 queued + 1 relayed');
  assert.equal(row.counselor_messages, 1);
});

await test('commands still work mid-session without being relayed', async () => {
  await send(people.seeker, '/themes');
  assert.equal(sent('copyMessage').length, 0);
  assert.ok(buttonData(101).some((d) => d.startsWith('t:')));
});

await test('a second person is queued while every counselor is busy', async () => {
  await send(people.seeker2, '/start');
  await press(people.seeker2, 'L:en');
  // firstOfferTo declined request 1 but is free for request 2.
  await press(people.seeker2, 'C+');
  await send(people.seeker2, 'I need someone to talk to');
  const pending = query("SELECT * FROM offers WHERE status = 'pending'");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request_id, 2);
  // They decline too: nobody else is free, so the request waits.
  await press(firstOfferTo, `o-:${pending[0].id}`);
  assert.equal(query('SELECT status FROM requests WHERE id = 2')[0].status, 'waiting');
  assert.match(lastText(102), /All counselors are busy/);
});

await test('ending a session asks for a rating and frees the counselor for the queue', async () => {
  await send(people.seeker, '⏹ ውይይቱን ጨርስ');
  const ended = query('SELECT * FROM requests WHERE id = 1')[0];
  assert.equal(ended.status, 'ended');
  assert.equal(ended.ended_by, 'user');
  assert.ok(sent('sendMessage', 101).some((c) => c.params.reply_markup?.remove_keyboard));
  // One message: the rating row on top of the main menu.
  assert.ok(buttonData(101).includes('r:1:5'));
  assert.ok(buttonData(101).includes('T') && buttonData(101).includes('C'));
  assert.ok(sent('sendMessage', secondOfferTo.id).some((c) => /ended session #1/.test(c.params.text)));
  assert.ok(sent('sendMessage', secondOfferTo.id).some((c) => buttons(c).some((b) => b.callback_data === 'T')), 'the counselor gets the menu back too');
  // The freed counselor is offered the queued request.
  const pending = query("SELECT * FROM offers WHERE status = 'pending'");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].request_id, 2);
  assert.equal(pending[0].counselor_id, counselorIdOf(secondOfferTo));
  await press(people.seeker, 'r:1:5');
  assert.equal(query('SELECT rating FROM requests WHERE id = 1')[0].rating, 5);
  assert.ok(!buttonData(101).includes('r:1:5'), 'the stars go away after rating');
  assert.ok(buttonData(101).includes('T'));
});

await test('an unanswered offer expires after 10 minutes and the person is told they are queued', async () => {
  rawSqlite().exec("UPDATE offers SET created_at = created_at - 11 * 60 * 1000 WHERE status = 'pending'");
  // Any update runs the sweep.
  await send(people.admin, '/start');
  assert.equal(query("SELECT count(*) AS n FROM offers WHERE status = 'expired'")[0].n, 1);
  assert.ok(sent('editMessageText', secondOfferTo.id).some((c) => /no response in time/.test(c.params.text)));
  // Both counselors have now passed on request 2; it waits.
  assert.equal(query('SELECT status FROM requests WHERE id = 2')[0].status, 'waiting');
});

await test('the person can cancel a waiting request and gets the main menu back', async () => {
  await press(people.seeker2, 'C-:2');
  assert.equal(query('SELECT status FROM requests WHERE id = 2')[0].status, 'cancelled');
  assert.match(lastText(102), /Your request was cancelled/);
  assert.ok(buttonData(102).includes('T') && buttonData(102).includes('C'));
});

await test('a request can be cancelled before the first message, without notifying anyone', async () => {
  await press(people.seeker2, 'C+');
  const id = query("SELECT id FROM requests WHERE status = 'intro'")[0].id;
  await press(people.seeker2, `C-:${id}`);
  assert.equal(query(`SELECT status FROM requests WHERE id = ${id}`)[0].status, 'cancelled');
  assert.equal(query(`SELECT count(*) AS n FROM offers WHERE request_id = ${id}`)[0].n, 0);
  assert.ok(buttonData(102).includes('T'));
});

await test('a counselor can pause and resume themselves', async () => {
  await send(people.c1, '/counselor');
  assert.match(lastText(201), /receiving requests/);
  await press(people.c1, 'cp');
  assert.equal(query('SELECT active FROM counselors WHERE user_id = 201')[0].active, 0);
  await press(people.c1, 'cr');
  assert.equal(query('SELECT active FROM counselors WHERE user_id = 201')[0].active, 1);
});

await test('removing a counselor mid-session puts the person back in the queue and keeps history', async () => {
  await press(people.seeker2, 'C+');
  await send(people.seeker2, 'Hello again');
  const offer = query("SELECT * FROM offers WHERE status = 'pending'")[0];
  const counselor = personFor(offer.counselor_id);
  await press(counselor, `o+:${offer.id}`);
  const ctx = { initData: { user: { id: 900 } } };
  const result = await saveEndpoint({ action: 'remove', id: offer.counselor_id }, ctx);
  assert.ok(!result.counselors.some((c) => c.id === offer.counselor_id));
  // The other counselor gets it.
  const next = query("SELECT * FROM offers WHERE status = 'pending'");
  assert.equal(next.length, 1);
  assert.notEqual(next[0].counselor_id, offer.counselor_id);
  assert.equal(query(`SELECT removed FROM counselors WHERE id = ${offer.counselor_id}`)[0].removed, 1);
  // Re-adding revives the same row.
  const again = await saveEndpoint({ action: 'add', handle: String(counselor.id) }, ctx);
  assert.equal(again.id, offer.counselor_id);
});

await test('a person who blocks the bot has their session closed', async () => {
  const offer = query("SELECT * FROM offers WHERE status = 'pending'")[0];
  const counselor = personFor(offer.counselor_id);
  await press(counselor, `o+:${offer.id}`);
  resetCalls();
  await onMemberHandler({ chat: { id: 102, type: 'private' }, from: from(people.seeker2), new_chat_member: { status: 'kicked' } });
  const request = query(`SELECT * FROM requests WHERE id = ${offer.request_id}`)[0];
  assert.equal(request.status, 'ended');
  assert.equal(request.ended_by, 'system');
  assert.equal(query('SELECT blocked FROM users WHERE id = 102')[0].blocked, 1);
});

await test('a relay to someone who has blocked the bot ends the session', async () => {
  await press(people.seeker, 'C+');
  await send(people.seeker, 'ሰላም');
  const offer = query("SELECT * FROM offers WHERE status = 'pending'")[0];
  const counselor = personFor(offer.counselor_id);
  await press(counselor, `o+:${offer.id}`);
  failures.copyMessage = () => new BotApiError('copyMessage', 403, 'Forbidden: bot was blocked by the user');
  await send(people.seeker, 'are you there?');
  delete failures.copyMessage;
  assert.equal(query(`SELECT status FROM requests WHERE id = ${offer.request_id}`)[0].status, 'ended');
});

// ── Dashboard ─────────────────────────────────────────────────────────────
await test('the dashboard reports users, content, counseling and per-counselor numbers', async () => {
  const ctx = { initData: { user: { id: 900 } } };
  const d = await dashboardEndpoint({}, ctx);
  assert.equal(d.users.total, 5);
  assert.equal(d.users.byLang.am, 1);
  assert.ok(d.content.byKind.article.total >= 4);
  assert.ok(d.content.topArticles[0].key.startsWith('names-of-god/'));
  assert.ok(d.counseling.requests >= 4);
  assert.ok(d.counseling.declined >= 2);
  assert.equal(d.counseling.expired, 1);
  assert.equal(d.counseling.avgRating, 5);
  assert.equal(d.series.users.length, 14);
  const c = d.counselors.find((x) => x.offers > 0);
  assert.ok(c.accepted >= 1 && c.acceptRate > 0);
  assert.ok(d.requests.every((r) => !('userId' in r)), 'requests stay anonymous');
  const detail = await counselorEndpoint({ id: c.id }, ctx);
  assert.ok(detail.history.length >= 1);
  await assert.rejects(counselorEndpoint({ id: 999 }, ctx), EndpointError);
});

await test('/stats gives admins a text summary', async () => {
  await send(people.admin, '/stats');
  assert.match(lastText(900), /Counseling/);
});

console.log(`\n${passed} scenarios passed`);

// Leaves the final dashboard payload for test/preview.html.
const fs = await import('node:fs');
fs.mkdirSync(new URL('./.db/', import.meta.url), { recursive: true });
const demo = await dashboardEndpoint({}, { initData: { user: { id: 900 } } });
const detail = await counselorEndpoint({ id: demo.counselors[0].id }, { initData: { user: { id: 900 } } });
fs.writeFileSync(new URL('./.db/demo.json', import.meta.url), JSON.stringify({ dashboard: demo, counselor: detail }));
