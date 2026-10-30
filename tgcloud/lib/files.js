import { api, db, fetch, InputFile } from 'sdk';
import { eq } from 'sdk/db';
import { cache } from '../schema.js';

// Telegram fetches photos by URL only up to 5 MB, and the Benaiah graphics are
// 2–9 MB PNGs. Cloudinary resizes on the fly, so albums use a resized JPEG and
// the originals go out as files.
export function photoUrl(url) {
  return String(url || '').replace(
    /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)(?!c_limit)/,
    '$1c_limit,w_2560,h_2560,q_auto:good,f_jpg/',
  );
}

export function fileName(url, fallback) {
  const last = String(url || '').split('?')[0].split('/').pop() || '';
  return /\.\w{2,4}$/.test(last) ? last : fallback;
}

function mimeOf(name) {
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  return 'application/octet-stream';
}

// The platform's fetch streams its body; it has no arrayBuffer().
async function readBytes(res) {
  const chunks = [];
  let length = 0;
  for await (const chunk of res.body) {
    chunks.push(chunk);
    length += chunk.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

async function cachedFileId(url) {
  const row = await db.select().from(cache).where(eq(cache.key, `file:${url}`)).get();
  return row?.payload?.fileId || null;
}

async function rememberFileId(url, fileId) {
  if (!fileId) return;
  const now = Date.now();
  await db.insert(cache).values({ key: `file:${url}`, fetchedAt: now, payload: { fileId } })
    .onConflictDoUpdate({ target: cache.key, set: { fetchedAt: now, payload: { fileId } } })
    .run();
}

// Sends files uncompressed, as document albums of up to 10. Telegram only
// accepts PDF/ZIP documents by URL, so a file is downloaded and uploaded the
// first time and its file_id is reused after that.
// items: [{ url, name }]
export async function sendOriginals(chatId, items) {
  for (let i = 0; i < items.length; i += 10) {
    const group = items.slice(i, i + 10);
    const media = [];
    for (const item of group) {
      const fileId = await cachedFileId(item.url);
      if (fileId) {
        media.push({ type: 'document', media: fileId });
        continue;
      }
      const res = await fetch(item.url);
      if (!res.ok) throw new Error(`Download failed (${res.status}) for ${item.url}`);
      const bytes = await readBytes(res);
      media.push({ type: 'document', media: new InputFile(bytes, item.name, { type: mimeOf(item.name) }) });
    }
    const sent = media.length === 1
      ? [await api.sendDocument({ chat_id: chatId, document: media[0].media })]
      : await api.sendMediaGroup({ chat_id: chatId, media });
    for (let n = 0; n < group.length; n += 1) {
      await rememberFileId(group[n].url, sent[n]?.document?.file_id);
    }
  }
}

// Photo album; a single photo goes out on its own. Throws BotApiError when
// Telegram can't fetch an image.
export async function sendAlbum(chatId, urls, caption) {
  for (let i = 0; i < urls.length; i += 10) {
    const group = urls.slice(i, i + 10).map(photoUrl);
    const withCaption = i === 0 && caption ? { caption, parse_mode: 'HTML' } : {};
    if (group.length === 1) await api.sendPhoto({ chat_id: chatId, photo: group[0], ...withCaption });
    else await api.sendMediaGroup({ chat_id: chatId, media: group.map((url, n) => ({ type: 'photo', media: url, ...(n === 0 ? withCaption : {}) })) });
  }
}

