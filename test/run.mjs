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
const { default: adminSaveEndpoint } = await import('../tgcloud/endpoints/adminAdminSave.js');
const { default: inlineQueryHandler } = await import('../tgcloud/handlers/inline_query.js');
const { default: setupEndpoint } = await import('../tgcloud/endpoints/setup.js');
const { chunkText, markdownToHtml } = await import('../tgcloud/lib/format.js');
const { CATALOG_CACHE_KEY, getCatalog, telegramPost } = await import('../tgcloud/lib/content.js');
const { saveBookmark, listBookmarks } = await import('../tgcloud/lib/bookmarks.js');
const { BROADCAST_BATCH_SIZE, sendBroadcastBatch } = await import('../tgcloud/lib/broadcast.js');
const { isAdmin } = await import('../tgcloud/lib/users.js');
const { aboutPage, articleView } = await import('../tgcloud/lib/views.js');

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
  for (const d of ['C', 'A', 'T']) assert.ok(buttonData(101).includes(d), d);
  assert.ok(!buttonData(101).includes('B'), 'Brand assets belongs inside About us');
  assert.equal(query('SELECT lang FROM users WHERE id = 101')[0].lang, 'am');
});

await test('themes list every theme from the API', async () => {
  await press(people.seeker, 'T');
  const data = buttonData(101);
  assert.ok(data.filter((d) => d.startsWith('t:')).length >= 3, data.join(','));
  assert.match(lastText(101), /ርዕሶች/);
});

await test('a fresh legacy cache without media cannot hide current video and narration buttons', async () => {
  const current = rawSqlite().prepare('SELECT payload FROM cache WHERE key = ?').get(CATALOG_CACHE_KEY).payload;
  const legacy = JSON.parse(current);
  for (const theme of legacy) for (const topic of theme.subtopics) delete topic.media;
  rawSqlite().prepare('INSERT INTO cache (key, fetched_at, payload) VALUES (?, ?, ?)').run('/api/v1/articles', Date.now(), JSON.stringify(legacy));
  rawSqlite().prepare('DELETE FROM cache WHERE key = ?').run(CATALOG_CACHE_KEY);
  await press(people.seeker, 'v:0:0:d:am');
  assert.ok(buttonData(101).includes('av:0:0:d:am:v'), 'Love has an Amharic video');
  assert.ok(buttonData(101).includes('an:0:0:d:am'), 'Love has an Amharic narration');
  const refreshed = JSON.parse(rawSqlite().prepare('SELECT payload FROM cache WHERE key = ?').get(CATALOG_CACHE_KEY).payload);
  assert.ok(refreshed[0].subtopics[0].media.devotional.am.narration);
  assert.equal(JSON.parse(query("SELECT payload FROM cache WHERE key = '/api/v1/articles'")[0].payload)[0].subtopics[0].media, undefined);
});

await test('a theme lists its subtopics with paging', async () => {
  await press(people.seeker, 't:1:0');
  const data = buttonData(101);
  assert.ok(data.includes('s:1:0'));
  assert.ok(data.includes('t:1:1'), 'Names of God has 10 topics, so a second page');
  await press(people.seeker, 't:1:1');
  assert.ok(buttonData(101).includes('s:1:8'));
});

await test('a subtopic offers devotional, study material and credits before format options', async () => {
  await press(people.seeker, 's:1:0');
  // From a text message to a photo: the old message is replaced.
  assert.equal(sent('deleteMessage').length, 1);
  const photo = sent('sendPhoto', 101)[0];
  // Resized by Cloudinary: Telegram won't fetch photos over 5 MB by URL.
  assert.match(photo.params.photo, /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/c_limit,/);
  assert.match(photo.params.caption, /ጄሆቫ ይርኤ/);
  const data = buttons(photo).map((b) => b.callback_data);
  for (const d of ['v:1:0:d:am', 'v:1:0:s:am', 'c:1:0']) assert.ok(data.includes(d), d);
  assert.ok(!data.some((d) => /^(?:a|g|av|an):/.test(d)));
});

await test('reading an article sends one rich message with buttons to switch language and type', async () => {
  await press(people.seeker, 'a:1:0:d:am');
  const rich = sent('sendRichMessage', 101)[0];
  assert.ok(rich, 'rich message sent');
  assert.match(rich.params.rich_message.markdown, /^# /);
  assert.match(rich.params.rich_message.markdown, /ጸሐፊ: ክሊንተን በየነ/);
  const data = buttons(rich).map((b) => b.callback_data).filter(Boolean);
  assert.ok(data.includes('v:1:0:d:en:n'));
  assert.ok(data.includes('v:1:0:s:am:n'));
  assert.ok(data.includes('v:1:0:d:am:n'));
  assert.ok(data.includes('g:1:0:q:d:am:n'));
  assert.ok(buttons(rich).some((b) => b.url?.startsWith('https://www.benaiah.org/articles/themes/Names%20of%20God/')));
  assert.ok(buttons(rich).some((b) => b.switch_inline_query === 'jehovah-jireh devotional am'), 'Share opens the chat picker directly');
  assert.ok(!buttons(rich).some((b) => b.web_app), 'articles open no web app');
  assert.ok(data.includes('bs:1:0:d:am:n'));
  assert.equal(query("SELECT count(*) AS n FROM events WHERE kind = 'article'")[0].n, 1);
});

await test('"Back" under an article sends the card as a new message instead of replacing the article', async () => {
  await press(people.seeker, 'v:1:0:d:am:n', { message_id: 77, chat: { id: 101 } });
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
  assert.ok(buttons(plain[plain.length - 1]).some((b) => b.switch_inline_query), 'the plain-text fallback can still be shared');
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
  for (const d of ['A:m', 'A:o', 'A:w', 'A:t', 'A:c', 'A:f', 'B']) assert.ok(buttonData(101).includes(d), d);
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

await test('About offers localized bug and feature drafts addressed to the existing contact chat', async () => {
  await press(people.seeker, 'A:f');
  assert.ok(buttonData(101).includes('A'));
  assert.equal(sent('copyMessage').length + sent('forwardMessage').length, 0, 'feedback is sent only when the user submits it in the contact chat');
  for (const lang of ['en', 'am']) {
    const view = aboutPage(lang, 'f');
    const links = view.keyboard.inline_keyboard.flat().filter((b) => b.url);
    assert.equal(links.length, 2);
    for (const link of links) {
      const url = new URL(link.url);
      assert.equal(url.origin + url.pathname, 'https://t.me/Benaiah_Contact');
      assert.ok(url.searchParams.get('text').includes('\n\n'));
      assert.match(url.searchParams.get('text'), lang === 'am' ? /በናያስ/ : /Benaiah Telegram bot/);
    }
    assert.notEqual(new URL(links[0].url).searchParams.get('text'), new URL(links[1].url).searchParams.get('text'));
  }
});

await test('Share buttons name the exact article type and language', async () => {
  for (const type of ['devotional', 'study_material']) {
    for (const lang of ['en', 'am']) {
      const view = await articleView('am', 1, 0, type, lang);
      const flat = view.keyboard.inline_keyboard.flat();
      const word = type === 'devotional' ? 'devotional' : 'study';
      assert.ok(flat.some((b) => b.switch_inline_query === `jehovah-jireh ${word} ${lang}`));
      assert.ok(!flat.some((b) => b.web_app));
    }
  }
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

await test('random devotional opens its options before reading in the reader’s language', async () => {
  await press(people.seeker, 'R');
  assert.equal(sent('sendRichMessage', 101).length, 0);
  const read = buttonData(101).find((d) => /^a:\d+:\d+:d:am$/.test(d));
  assert.ok(read);
  await press(people.seeker, read);
  const rich = sent('sendRichMessage', 101)[0];
  assert.ok(rich);
  assert.match(rich.params.rich_message.markdown, /[ሀ-፿]/);
});

// Deterministic media fixtures exercise optional fields independently of live uploads.
async function withMediaCatalog(change, work) {
  const saved = rawSqlite().prepare('SELECT payload FROM cache WHERE key = ?').get(CATALOG_CACHE_KEY).payload;
  const catalog = JSON.parse(saved);
  const topic = catalog[1].subtopics[0];
  topic.media = {
    devotional: {
      en: { video: null, short: 'https://www.youtube.com/shorts/PSYPXH5RnHs', narration: 'https://t.me/benaiah_org/258' },
      am: { video: 'https://www.youtube.com/watch?v=amVideo', short: null, narration: 'https://t.me/Benaiah_Amharic/212' },
    },
    study_material: {
      en: { video: 'https://www.youtube.com/watch?v=lNWArDDGR9k', short: null, narration: 'https://t.me/benaiah_org/259' },
      am: { video: null, short: null, narration: null },
    },
  };
  change(topic, catalog);
  rawSqlite().prepare('UPDATE cache SET payload = ? WHERE key = ?').run(JSON.stringify(catalog), CATALOG_CACHE_KEY);
  try { await work(); }
  finally { rawSqlite().prepare('UPDATE cache SET payload = ? WHERE key = ?').run(saved, CATALOG_CACHE_KEY); }
}

await test('article options use only the chosen type and language, including Shorts', async () => {
  await withMediaCatalog(() => {}, async () => {
    await press(people.seeker, 'v:1:0:d:en');
    const data = buttonData(101);
    for (const d of ['a:1:0:d:en', 'g:1:0:q:d:en', 'g:1:0:y:d:en', 'av:1:0:d:en:s', 'an:1:0:d:en']) assert.ok(data.includes(d), d);
    assert.ok(!data.includes('av:1:0:d:en:v'), 'no full video for this devotional');
    assert.equal(sent('sendRichMessage').length, 0, 'selecting a type does not send its text');
    await press(people.seeker, 'v:1:0:s:en');
    assert.ok(buttonData(101).includes('av:1:0:s:en:v'));
    assert.ok(!buttonData(101).includes('av:1:0:s:en:s'));
    await press(people.seeker, 'v:1:0:s:am');
    assert.ok(buttonData(101).includes('a:1:0:s:am'));
    assert.ok(!buttonData(101).some((d) => /^(av|an):/.test(d)), 'English media must not leak into Amharic');
    for (const call of calls) for (const b of buttons(call)) if (b.callback_data) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
  });
});

await test('missing media fields and unavailable translations still offer reading and graphics', async () => {
  await withMediaCatalog((topic) => {
    delete topic.media;
    topic.articles.devotional.am = null;
  }, async () => {
    await press(people.seeker, 'v:1:0:d:am');
    assert.ok(buttonData(101).includes('a:1:0:d:en'), 'fallback article uses its actual language');
    assert.ok(buttonData(101).includes('g:1:0:q:d:en'));
    assert.ok(!buttonData(101).some((d) => /^(av|an):/.test(d)));
    const share = calls.flatMap(buttons).find((b) => b.switch_inline_query);
    assert.equal(share.switch_inline_query, 'jehovah-jireh devotional en', 'share the available translation');
  });
});

await test('videos and Shorts send the correct YouTube preview and preserve the article', async () => {
  await withMediaCatalog(() => {}, async () => {
    for (const [data, url, back] of [
      ['av:1:0:s:en:v', 'https://www.youtube.com/watch?v=lNWArDDGR9k', 'v:1:0:s:en:n'],
      ['av:1:0:d:en:s:n', 'https://www.youtube.com/shorts/PSYPXH5RnHs', 'v:1:0:d:en:n'],
    ]) {
      await press(people.seeker, data);
      const video = sent('sendMessage', 101)[0];
      assert.equal(video.params.link_preview_options.url, url);
      assert.equal(video.params.link_preview_options.is_disabled, false);
      assert.ok(buttons(video).some((b) => b.url === url));
      assert.ok(buttonData(101).includes(back));
      assert.equal(sent('deleteMessage').length, 0);
    }
  });
});

await test('narrations forward the exact channel post for each article and language', async () => {
  await withMediaCatalog(() => {}, async () => {
    for (const [data, channel, id] of [
      ['an:1:0:d:en', '@benaiah_org', 258],
      ['an:1:0:s:en', '@benaiah_org', 259],
      ['an:1:0:d:am:n', '@Benaiah_Amharic', 212],
    ]) {
      await press(people.seeker, data);
      assert.deepEqual(sent('forwardMessage', 101)[0].params, { chat_id: 101, from_chat_id: channel, message_id: id });
      assert.equal(sent('copyMessage').length, 0, 'retain the source channel attribution');
      assert.equal(sent('deleteMessage').length, 0);
      assert.ok(buttonData(101).includes(`${data.replace(/^an:/, 'v:').replace(/:n$/, '')}:n`));
    }
  });
});

await test('protected or inaccessible narrations offer the original post when forwarding fails', async () => {
  await withMediaCatalog(() => {}, async () => {
    failures.forwardMessage = () => new BotApiError('forwardMessage', 400, 'Bad Request: message is protected');
    try { await press(people.seeker, 'an:1:0:d:am'); }
    finally { delete failures.forwardMessage; }
    assert.ok(buttons(sent('sendMessage', 101)[0]).some((b) => b.url === 'https://t.me/Benaiah_Amharic/212'));
    assert.ok(buttonData(101).includes('v:1:0:d:am:n'));
  });
});

await test('stale media buttons never send another type or language’s media', async () => {
  await withMediaCatalog(() => {}, async () => {
    for (const data of ['av:1:0:d:en:v', 'av:1:0:s:am:v', 'an:1:0:s:am']) {
      await press(people.seeker, data);
      assert.equal(sent('forwardMessage').length, 0);
      assert.ok(sent('sendMessage', 101).length > 0);
      assert.ok(!calls.some((c) => c.params.link_preview_options?.url));
    }
  });
});

await test('graphics use the selected article language and return to its options', async () => {
  await withMediaCatalog((topic) => {
    topic.images.square.en = ['https://example.com/english.png'];
    topic.images.square.am = ['https://example.com/amharic.png'];
  }, async () => {
    await press(people.seeker, 'g:1:0:q:d:en:n');
    assert.equal(sent('sendPhoto', 101)[0].params.photo, 'https://example.com/english.png');
    assert.ok(buttonData(101).includes('gd:1:0:q:d:en'));
    assert.ok(buttonData(101).includes('v:1:0:d:en:n'));
    assert.equal(sent('deleteMessage').length, 0);
    rawSqlite().prepare('INSERT INTO cache (key, fetched_at, payload) VALUES (?, ?, ?)').run(
      'file:https://example.com/english.png', Date.now(), JSON.stringify({ fileId: 'file-english-original' }),
    );
    await press(people.seeker, 'gd:1:0:q:d:en');
    assert.equal(sent('sendDocument', 101)[0].params.document, 'file-english-original');
    assert.ok(buttonData(101).includes('v:1:0:d:en:n'));
  });
});

await test('narration links parse public and private posts and reject malformed links', () => {
  assert.deepEqual(telegramPost('https://t.me/benaiah_org/258?single'), { from_chat_id: '@benaiah_org', message_id: 258 });
  assert.deepEqual(telegramPost('https://t.me/c/1234567890/12'), { from_chat_id: '-1001234567890', message_id: 12 });
  for (const url of [null, '', 'https://example.com/benaiah_org/258', 'https://t.me/benaiah_org/0', 'https://t.me/benaiah_org/12/34']) assert.equal(telegramPost(url), null);
});

// ── Counselors and setup ──────────────────────────────────────────────────
const inline = async (person, q) => {
  resetCalls();
  await inlineQueryHandler({ id: 'q1', from: person, query: q, offset: '' });
  const call = sent('answerInlineQuery')[0];
  assert.ok(call, 'the inline query is answered');
  return call.params.results;
};

await test('sharing posts one card for the exact article, with buttons and no web app', async () => {
  const [card, ...rest] = await inline(people.seeker, 'jehovah-jireh devotional en');
  assert.equal(rest.length, 0);
  assert.equal(card.type, 'photo');
  assert.match(card.photo_url, /\/image\/upload\/c_limit,.*f_jpg/, 'a resized JPEG, as Telegram requires');
  assert.match(card.thumbnail_url, /w_320/);
  assert.match(card.caption, /^<b>Jehovah Jireh<\/b>/);
  const flat = card.reply_markup.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.url === 'https://t.me/BenaiahTestBot?start=a_jehovah-jireh_d_en'));
  assert.ok(flat.some((b) => b.url?.startsWith('https://www.benaiah.org/articles/themes/Names%20of%20God/Jehovah%20Jireh/devotional_en')));
  assert.ok(flat.some((b) => b.switch_inline_query === 'jehovah-jireh devotional en'));
  assert.deepEqual(await inline(people.seeker, 'no-such-topic devotional en'), []);
});

await test('every start link fits Telegram limits and every card is valid', async () => {
  const cards = [];
  for (const q of ['', 'armor', 'jehovah', 'love']) cards.push(...await inline(people.seeker, q));
  assert.ok(cards.length >= 10);
  for (const card of cards) {
    assert.ok(Buffer.byteLength(card.id) <= 64);
    assert.ok(card.caption.length <= 1024);
    const link = card.reply_markup.inline_keyboard.flat().find((b) => b.url?.includes('?start='));
    assert.match(link.url.split('?start=')[1], /^[A-Za-z0-9_-]{1,64}$/);
  }
});

await test('free-text inline search follows the language and does not register the person', async () => {
  const stranger = { id: 555, first_name: 'New', language_code: 'am' };
  const results = await inline(stranger, 'ተስፋ');
  assert.ok(results.length >= 1);
  assert.match(results[0].caption, /[ሀ-፿]/);
  assert.equal(query('SELECT count(*) AS n FROM users WHERE id = 555')[0].n, 0);
  assert.equal(sent('answerInlineQuery')[0].params.is_personal, true);
});

await test('"Read in the bot" opens the shared article, even for someone new', async () => {
  const newcomer = { id: 556, first_name: 'New' };
  await send(newcomer, '/start a_jehovah-jireh_s_am');
  assert.equal(query('SELECT lang FROM users WHERE id = 556')[0].lang, 'am');
  assert.ok(buttonData(556).some((d) => d.startsWith('a:1:0:s:am')), buttonData(556).join(','));
  await send(newcomer, '/start a_no-such-topic_s_am');
  assert.ok(buttonData(556).includes('T'), 'a dead link falls back to the menu');
  rawSqlite().exec('DELETE FROM users WHERE id = 556');
  rawSqlite().exec('DELETE FROM events WHERE user_id = 556');
});

await test('Bookmarks appears before About us and starts with a personal empty list', async () => {
  await send(people.seeker, '/menu');
  assert.ok(buttonData(101).indexOf('BM:0') < buttonData(101).indexOf('A'));
  await send(people.seeker, '/bookmarks');
  assert.equal(buttonData(101).filter((d) => d.startsWith('bo:')).length, 0);
  assert.ok(buttonData(101).includes('M'));
});

await test('article bookmarks save once, update the button in place and remember type and language', async () => {
  await press(people.seeker, 'v:1:0:d:en');
  const call = calls.findLast((c) => c.params.reply_markup);
  assert.ok(buttons(call).some((b) => b.callback_data === 'bs:1:0:d:en'));
  const message = { message_id: 77, chat: { id: 101, type: 'private' }, photo: [{}], reply_markup: call.params.reply_markup };
  await press(people.seeker, 'bs:1:0:d:en', message);
  let saved = query('SELECT * FROM bookmarks WHERE user_id = 101');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].theme_slug, 'names-of-god');
  assert.equal(saved[0].subtopic_slug, 'jehovah-jireh');
  assert.equal(saved[0].article_type, 'devotional');
  assert.equal(saved[0].lang, 'en');
  assert.ok(buttons(sent('editMessageReplyMarkup')[0]).some((b) => b.callback_data === 'bu:1:0:d:en'));
  assert.equal(sent('deleteMessage').length + sent('editMessageText').length, 0, 'keep the existing article or card');
  await press(people.seeker, 'bs:1:0:d:en', message);
  assert.equal(query('SELECT * FROM bookmarks WHERE user_id = 101').length, 1);
  await press(people.seeker, 'bs:1:0:s:am:n');
  saved = query('SELECT * FROM bookmarks WHERE user_id = 101');
  assert.equal(saved.length, 2);
  await press(people.seeker, 'BM:0');
  assert.equal(buttonData(101).filter((d) => d.startsWith('bo:')).length, 2);
});

await test('saved articles reopen correctly after the API changes catalog ordering', async () => {
  const row = query("SELECT id FROM bookmarks WHERE user_id = 101 AND article_type = 'devotional'")[0];
  await withMediaCatalog((topic, catalog) => { catalog[1].subtopics.reverse(); }, async () => {
    await press(people.seeker, `bo:${row.id}`);
    assert.ok(buttonData(101).includes('a:1:9:d:en'));
    assert.ok(buttonData(101).includes('bu:1:9:d:en'));
  });
});

await test('bookmarks cannot be opened, deleted or displayed in public by another user', async () => {
  const row = query('SELECT id FROM bookmarks WHERE user_id = 101')[0];
  await press(people.seeker2, `bo:${row.id}`);
  assert.equal(sent('answerCallbackQuery')[0].params.show_alert, true);
  await press(people.seeker2, `bd:${row.id}:0`);
  assert.equal(query('SELECT * FROM bookmarks WHERE user_id = 101').length, 2);
  assert.equal(buttonData(102).filter((d) => d.startsWith('bo:')).length, 0);
  await press(people.seeker, 'BM:0', { message_id: 999, chat: { id: -123, type: 'group' }, text: 'forwarded menu' });
  assert.equal(sent('answerCallbackQuery')[0].params.show_alert, true);
  assert.equal(sent('sendMessage', -123).length + sent('editMessageText', -123).length, 0);
});

await test('bookmarks can be removed from the article and the saved list', async () => {
  await press(people.seeker, 'bu:1:0:d:en:n');
  assert.equal(query('SELECT * FROM bookmarks WHERE user_id = 101').length, 1);
  const row = query('SELECT id FROM bookmarks WHERE user_id = 101')[0];
  await press(people.seeker, `bd:${row.id}:0`);
  assert.equal(query('SELECT * FROM bookmarks WHERE user_id = 101').length, 0);
  assert.equal(buttonData(101).filter((d) => d.startsWith('bo:')).length, 0);
});

await test('bookmark pagination clamps to the previous page after deleting its final entry', async () => {
  const catalog = await getCatalog();
  for (const theme of catalog.themes) {
    for (const topic of theme.subtopics) {
      if (topic.articles.devotional.en && (await listBookmarks(101)).total < 9) await saveBookmark(101, theme, topic, 'devotional', 'en');
    }
  }
  await press(people.seeker, 'BM:0');
  assert.equal(buttonData(101).filter((d) => d.startsWith('bo:')).length, 8);
  assert.ok(buttonData(101).includes('BM:1'));
  await press(people.seeker, 'BM:1');
  const open = buttonData(101).filter((d) => d.startsWith('bo:'));
  assert.equal(open.length, 1);
  await press(people.seeker, `bd:${open[0].split(':')[1]}:1`);
  assert.equal(buttonData(101).filter((d) => d.startsWith('bo:')).length, 8);
  assert.ok(!buttonData(101).includes('BM:1'));
  rawSqlite().exec('DELETE FROM bookmarks');
});

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
  assert.ok(sent('setMyCommands').some((c) => c.params.scope?.chat_id === 900 && c.params.commands.some((cmd) => cmd.command === 'broadcast')));
  assert.ok(sent('setMyCommands').filter((c) => !c.params.scope).every((c) => !c.params.commands.some((cmd) => cmd.command === 'broadcast')));
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
  assert.ok(calls.some((c) => c.params.chat_id === secondOfferTo.id && buttons(c).some((b) => b.callback_data === 'T')), 'the counselor gets the menu back too');
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

// ── Welcome and admin broadcasts ───────────────────────────────────────────
await test('welcome uses the supplied static image and counseling keeps the default button color', async () => {
  await send(people.seeker, '/menu');
  const welcome = sent('sendPhoto', 101)[0];
  assert.equal(welcome.params.photo, 'https://app1.tgcloud.ai/assets/welcome.png');
  const counsel = buttons(welcome).find((b) => b.callback_data === 'C');
  assert.ok(counsel);
  assert.equal(counsel.style, undefined);
  assert.ok(!buttons(welcome).some((b) => b.callback_data === 'BC'));
  await send(people.admin, '/menu');
  const broadcast = buttons(sent('sendPhoto', 900)[0]).find((b) => b.callback_data === 'BC');
  assert.equal(broadcast.text, '📣 Broadcast');
});

async function withBroadcastUsers(work, extraUsers = 0) {
  const saved = query('SELECT id, blocked, state, lang FROM users');
  rawSqlite().exec("DELETE FROM broadcasts; DELETE FROM cache WHERE key LIKE 'broadcast:retry:%'; UPDATE users SET blocked = 0; UPDATE users SET state = '', lang = 'en' WHERE id = 900");
  const insert = rawSqlite().prepare("INSERT INTO users (id, first_name, lang, state, blocked, created_at, last_seen_at) VALUES (?, 'Recipient', 'en', '', 0, ?, ?)");
  for (let i = 0; i < extraUsers; i++) insert.run(10000 + i, Date.now() - 1000, Date.now());
  try { await work(); }
  finally {
    for (const key of Object.keys(failures)) delete failures[key];
    rawSqlite().exec("DELETE FROM broadcasts; DELETE FROM cache WHERE key LIKE 'broadcast:retry:%'; DELETE FROM users WHERE id >= 10000");
    const restore = rawSqlite().prepare('UPDATE users SET blocked = ?, state = ?, lang = ? WHERE id = ?');
    for (const user of saved) restore.run(user.blocked, user.state, user.lang, user.id);
  }
}

async function makeBroadcast(extra = {}) {
  await send(people.admin, '/broadcast');
  const source = await send(people.admin, 'An announcement', extra);
  const row = query('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 1')[0];
  assert.ok(row, 'a draft was created');
  return { row, source };
}

await test('broadcast is admin-only through both commands and forged callback buttons', async () => {
  await withBroadcastUsers(async () => {
    await send(people.seeker, '/broadcast');
    assert.equal(sent('copyMessage').length, 0);
    assert.equal(query('SELECT * FROM broadcasts').length, 0);
    for (const data of ['BC', 'BCS:1', 'BCX:1']) {
      await press(people.seeker, data);
      assert.equal(sent('copyMessage').length, 0);
      assert.equal(sent('answerCallbackQuery')[0].params.show_alert, true);
    }
  });
});

await test('a broadcast draft previews only to the admin and copies that exact preview after confirmation', async () => {
  await withBroadcastUsers(async () => {
    const { row, source } = await makeBroadcast({ text: undefined, photo: [{ file_id: 'announcement-photo' }], caption: 'Photo caption', caption_entities: [{ type: 'bold', offset: 0, length: 5 }] });
    assert.equal(row.status, 'draft');
    assert.equal(row.total, 5);
    assert.equal(sent('copyMessage').length, 1);
    assert.equal(sent('copyMessage')[0].params.chat_id, 900);
    assert.equal(sent('copyMessage')[0].params.message_id, source.message_id);
    assert.notEqual(row.message_id, source.message_id, 'use the immutable bot preview as the broadcast source');
    assert.ok(buttonData(900).includes(`BCS:${row.id}`));
    await press(people.admin, `BCS:${row.id}`);
    const copies = sent('copyMessage');
    assert.equal(copies.length, 5);
    assert.deepEqual(copies.map((c) => c.params.chat_id), [101, 102, 201, 202, 900]);
    assert.ok(copies.every((c) => c.params.from_chat_id === 900 && c.params.message_id === row.message_id));
    assert.ok(copies.every((c) => c.params.reply_markup.inline_keyboard.length === 0));
    const done = query(`SELECT * FROM broadcasts WHERE id = ${row.id}`)[0];
    assert.equal(done.status, 'done');
    assert.equal(done.sent, 5);
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(sent('copyMessage').length, 0, 'repeated confirmation cannot resend a completed broadcast');
  });
});

await test('cancel works during composition and after preview without delivering a broadcast', async () => {
  await withBroadcastUsers(async () => {
    await press(people.admin, 'BC');
    assert.equal(query('SELECT state FROM users WHERE id = 900')[0].state, 'broadcast');
    await press(people.admin, 'BCX:0');
    assert.equal(query('SELECT state FROM users WHERE id = 900')[0].state, '');
    const { row } = await makeBroadcast();
    await press(people.admin, 'BCX:0'); // The older composition prompt is still visible.
    assert.equal(query(`SELECT status FROM broadcasts WHERE id = ${row.id}`)[0].status, 'cancelled');
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(sent('copyMessage').length, 0);
    const second = await makeBroadcast();
    await press(people.admin, `BCX:${second.row.id}`);
    assert.equal(query(`SELECT status FROM broadcasts WHERE id = ${second.row.id}`)[0].status, 'cancelled');
  });
});

await test('unsupported albums and uncopyable messages stay in composition with no draft', async () => {
  await withBroadcastUsers(async () => {
    await send(people.admin, '/broadcast');
    await send(people.admin, undefined, { photo: [{}], media_group_id: 'album' });
    assert.equal(sent('copyMessage').length, 0);
    assert.equal(query('SELECT * FROM broadcasts').length, 0);
    failures.copyMessage = () => new BotApiError('copyMessage', 400, "message can't be copied");
    await send(people.admin, 'Protected message');
    assert.equal(query('SELECT * FROM broadcasts').length, 0);
    assert.equal(query('SELECT state FROM users WHERE id = 900')[0].state, 'broadcast');
    delete failures.copyMessage;
    await press(people.admin, 'M');
    assert.equal(query('SELECT state FROM users WHERE id = 900')[0].state, '', 'navigation leaves composition');
  });
});

await test('broadcast batches resume without duplicates, skip blocked users and exclude later signups', async () => {
  await withBroadcastUsers(async () => {
    rawSqlite().exec('UPDATE users SET blocked = 1 WHERE id = 10041');
    const { row } = await makeBroadcast();
    assert.equal(row.total, 46);
    rawSqlite().prepare("INSERT INTO users (id, state, blocked, created_at, last_seen_at) VALUES (10999, '', 0, ?, ?)").run(row.created_at + 1000, Date.now());
    const delivered = [];
    await press(people.admin, `BCS:${row.id}`);
    delivered.push(...sent('copyMessage').map((c) => c.params.chat_id));
    assert.equal(delivered.length, BROADCAST_BATCH_SIZE);
    assert.equal(query(`SELECT status FROM broadcasts WHERE id = ${row.id}`)[0].status, 'ready');
    await send(people.admin, '/broadcast');
    assert.equal(sent('copyMessage').length, 0, 'reopen the current broadcast rather than composing a new one');
    assert.ok(buttonData(900).includes(`BCS:${row.id}`));
    for (let i = 0; i < 2; i++) {
      await press(people.admin, `BCS:${row.id}`);
      delivered.push(...sent('copyMessage').map((c) => c.params.chat_id));
    }
    assert.equal(delivered.length, 46);
    assert.equal(new Set(delivered).size, 46);
    assert.ok(!delivered.includes(10041) && !delivered.includes(10999));
    assert.equal(query(`SELECT status FROM broadcasts WHERE id = ${row.id}`)[0].status, 'done');
  }, 42);
});

await test('users who block the bot are marked unavailable and other recipients still receive the broadcast', async () => {
  await withBroadcastUsers(async () => {
    const { row } = await makeBroadcast();
    failures.copyMessage = (p) => p.chat_id === 101 ? new BotApiError('copyMessage', 403, 'bot was blocked by the user') : null;
    await press(people.admin, `BCS:${row.id}`);
    const done = query(`SELECT * FROM broadcasts WHERE id = ${row.id}`)[0];
    assert.equal(done.status, 'done');
    assert.equal(done.sent, 4);
    assert.equal(done.blocked, 1);
    assert.equal(query('SELECT blocked FROM users WHERE id = 101')[0].blocked, 1);
  });
});

await test('rate limits preserve the recipient cursor and honor retry_after before resuming', async () => {
  await withBroadcastUsers(async () => {
    const { row } = await makeBroadcast();
    failures.copyMessage = () => new BotApiError('copyMessage', 429, 'Too Many Requests', { retry_after: 60 });
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(query(`SELECT cursor FROM broadcasts WHERE id = ${row.id}`)[0].cursor, 0);
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(sent('copyMessage').length, 0, 'do not retry before Telegram permits it');
    delete failures.copyMessage;
    rawSqlite().prepare('UPDATE cache SET payload = ? WHERE key = ?').run(JSON.stringify({ until: Date.now() - 1 }), `broadcast:retry:${row.id}`);
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(sent('copyMessage')[0].params.chat_id, 101, 'retry the same recipient');
    assert.equal(query(`SELECT sent FROM broadcasts WHERE id = ${row.id}`)[0].sent, 5);
  });
});

await test('temporary Telegram failures pause the broadcast without losing the next recipient', async () => {
  await withBroadcastUsers(async () => {
    const { row } = await makeBroadcast();
    failures.copyMessage = () => new BotApiError('copyMessage', 500, 'Internal Server Error');
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(query(`SELECT status FROM broadcasts WHERE id = ${row.id}`)[0].status, 'ready');
    assert.equal(query(`SELECT cursor FROM broadcasts WHERE id = ${row.id}`)[0].cursor, 0);
    delete failures.copyMessage;
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(query(`SELECT sent FROM broadcasts WHERE id = ${row.id}`)[0].sent, 5);
  });
});

await test('concurrent confirmation clicks claim one batch and interrupted batches can recover', async () => {
  await withBroadcastUsers(async () => {
    let { row } = await makeBroadcast();
    resetCalls();
    await Promise.all([sendBroadcastBatch(900, row.id, 'en'), sendBroadcastBatch(900, row.id, 'en')]);
    assert.equal(sent('copyMessage').length, 5);
    assert.equal(new Set(sent('copyMessage').map((c) => c.params.chat_id)).size, 5);
    ({ row } = await makeBroadcast());
    rawSqlite().prepare("UPDATE broadcasts SET status = 'sending', started_at = ? WHERE id = ?").run(Date.now(), row.id);
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(sent('copyMessage').length, 0);
    rawSqlite().prepare('UPDATE broadcasts SET started_at = ? WHERE id = ?').run(Date.now() - 121000, row.id);
    await press(people.admin, `BCS:${row.id}`);
    assert.equal(sent('copyMessage').length, 5);
  });
});

await test('admins cannot send or cancel another admin’s broadcast', async () => {
  await withBroadcastUsers(async () => {
    const { row } = await makeBroadcast();
    rawSqlite().prepare('UPDATE broadcasts SET admin_id = 901 WHERE id = ?').run(row.id);
    for (const action of ['BCS', 'BCX']) {
      await press(people.admin, `${action}:${row.id}`);
      assert.equal(sent('copyMessage').length, 0);
      assert.equal(query(`SELECT status FROM broadcasts WHERE id = ${row.id}`)[0].status, 'draft');
    }
  });
});

await test('broadcast composition takes precedence over an admin’s counseling conversation', async () => {
  await withBroadcastUsers(async () => {
    rawSqlite().prepare("INSERT INTO requests (id, user_id, lang, status, counselor_id, created_at) VALUES (99999, 900, 'en', 'active', 1, ?)").run(Date.now());
    try {
      const { row } = await makeBroadcast();
      assert.equal(row.status, 'draft');
      assert.equal(sent('copyMessage').length, 1);
      assert.equal(sent('copyMessage')[0].params.chat_id, 900);
      assert.equal(query('SELECT user_messages FROM requests WHERE id = 99999')[0].user_messages, 0);
    } finally { rawSqlite().exec('DELETE FROM requests WHERE id = 99999'); }
  });
});

// ── Managed admins ─────────────────────────────────────────────────────────
const ownerCtx = { initData: { user: { id: 900 } } };
const addedAdminCtx = { initData: { user: { id: 101 } } };
const forbidden = (error) => error instanceof EndpointError && error.parameters.code === 'FORBIDDEN';

await test('all admin management operations reject non-admin and missing verified callers', async () => {
  for (const ctx of [{}, { user: { id: 900 } }, addedAdminCtx]) {
    for (const action of ['add', 'update', 'remove']) {
      await assert.rejects(adminSaveEndpoint({ action, handle: '102', userId: 900 }, ctx), forbidden);
    }
  }
  assert.equal(query('SELECT * FROM admins').length, 0);
  const d = await dashboardEndpoint({}, ownerCtx);
  assert.equal(d.admins.length, 1);
  assert.equal(d.admins[0].owner, true);
  assert.equal(d.admins[0].canRemove, false);
  assert.equal(d.managementUi.admins, 'Admins');
});

await test('a known username grants access by account ID, including dashboard, commands and broadcasts', async () => {
  const result = await adminSaveEndpoint({ action: 'add', handle: '@abebe', displayName: 'New admin' }, ownerCtx);
  assert.ok(result.admins.some((a) => a.userId === 101 && !a.owner && a.canRemove));
  assert.equal(await isAdmin(101), true);
  const d = await dashboardEndpoint({}, addedAdminCtx);
  assert.equal(d.callerId, 101);
  assert.equal(d.admins.find((a) => a.userId === 101).canRemove, false);
  await send(people.seeker, '/start');
  assert.ok(buttonData(101).includes('BC'));
  assert.ok(sent('setMyCommands').some((c) => c.params.scope?.chat_id === 101));
  await press(people.seeker, 'BC');
  assert.equal(query('SELECT state FROM users WHERE id = 101')[0].state, 'broadcast');
  await press(people.seeker, 'BCX:0');
});

await test('admins can add numeric IDs before first contact, rename them and revoke access', async () => {
  await adminSaveEndpoint({ action: 'add', handle: '303', displayName: 'Future admin' }, addedAdminCtx);
  assert.equal(await isAdmin(303), true);
  await adminSaveEndpoint({ action: 'update', userId: 303, displayName: '  Renamed admin  ' }, ownerCtx);
  const list = (await dashboardEndpoint({}, ownerCtx)).admins;
  assert.equal(list.find((a) => a.userId === 303).displayName, 'Renamed admin');
  await assert.rejects(adminSaveEndpoint({ action: 'add', handle: '303' }, ownerCtx), /already an admin/);
  await assert.rejects(adminSaveEndpoint({ action: 'add', handle: '@never_opened' }, ownerCtx), /open the bot first/);
  await assert.rejects(adminSaveEndpoint({ action: 'add', handle: '0' }, ownerCtx), /positive numeric/);
  await assert.rejects(adminSaveEndpoint({ action: 'add', handle: '-1' }, ownerCtx), /positive numeric/);
  await adminSaveEndpoint({ action: 'remove', userId: 303 }, addedAdminCtx);
  assert.equal(await isAdmin(303), false);
});

await test('configured owners and the caller’s own admin access cannot be removed', async () => {
  await assert.rejects(adminSaveEndpoint({ action: 'remove', userId: 900 }, addedAdminCtx), /Configured owners/);
  await assert.rejects(adminSaveEndpoint({ action: 'update', userId: 900, displayName: 'Changed' }, addedAdminCtx), /Configured owners/);
  await assert.rejects(adminSaveEndpoint({ action: 'remove', userId: 101 }, addedAdminCtx), /your own admin access/);
  assert.equal(await isAdmin(900), true);
  assert.equal(await isAdmin(101), true);
});

await test('managed admins can add, rename, pause, resume and remove counselors through the webapp endpoints', async () => {
  const added = await saveEndpoint({ action: 'add', handle: '@new_counselor', displayName: 'New counselor' }, addedAdminCtx);
  assert.ok(added.counselors.some((c) => c.id === added.id && !c.linked));
  await saveEndpoint({ action: 'update', id: added.id, displayName: 'Counselor renamed', active: false }, addedAdminCtx);
  let detail = await counselorEndpoint({ id: added.id }, addedAdminCtx);
  assert.equal(detail.counselor.displayName, 'Counselor renamed');
  assert.equal(detail.counselor.active, false);
  await saveEndpoint({ action: 'update', id: added.id, active: true }, addedAdminCtx);
  detail = await counselorEndpoint({ id: added.id }, addedAdminCtx);
  assert.equal(detail.counselor.active, true);
  const removed = await saveEndpoint({ action: 'remove', id: added.id }, addedAdminCtx);
  assert.ok(!removed.counselors.some((c) => c.id === added.id));
  assert.equal(query(`SELECT removed FROM counselors WHERE id = ${added.id}`)[0].removed, 1);
});

await test('concurrent grants cannot create duplicate admins', async () => {
  const results = await Promise.allSettled([
    adminSaveEndpoint({ action: 'add', handle: '202' }, ownerCtx),
    adminSaveEndpoint({ action: 'add', handle: '202' }, ownerCtx),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(query('SELECT * FROM admins WHERE user_id = 202').length, 1);
  await adminSaveEndpoint({ action: 'remove', userId: 202 }, ownerCtx);
});

await test('revoked admins immediately lose access to every endpoint, broadcast controls and admin menus', async () => {
  await adminSaveEndpoint({ action: 'remove', userId: 101 }, ownerCtx);
  assert.equal(await isAdmin(101), false);
  for (const endpoint of [dashboardEndpoint, counselorEndpoint, saveEndpoint, adminSaveEndpoint, setupEndpoint]) {
    await assert.rejects(endpoint({}, addedAdminCtx), forbidden);
  }
  await send(people.seeker, '/menu');
  assert.ok(!buttonData(101).includes('BC'));
  await press(people.seeker, 'BC');
  assert.equal(sent('answerCallbackQuery')[0].params.show_alert, true);
  assert.equal(query('SELECT * FROM admins').length, 0);
});

console.log(`\n${passed} scenarios passed`);

// Leaves the final dashboard payload for test/preview.html.
const fs = await import('node:fs');
fs.mkdirSync(new URL('./.db/', import.meta.url), { recursive: true });
const demo = await dashboardEndpoint({}, { initData: { user: { id: 900 } } });
const detail = await counselorEndpoint({ id: demo.counselors[0].id }, { initData: { user: { id: 900 } } });
fs.writeFileSync(new URL('./.db/demo.json', import.meta.url), JSON.stringify({ dashboard: demo, counselor: detail }));
