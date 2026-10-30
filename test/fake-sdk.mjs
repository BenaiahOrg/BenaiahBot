// A local stand-in for the platform's `sdk`: the database from fake-db.mjs, a
// Bot API that records every call, and the real network fetch. Test-only.
import { db } from './fake-db.mjs';

export { db };

export class BotApiError extends Error {
  constructor(method, code, description, parameters) {
    super(`${method}: ${description}`);
    this.method = method;
    this.code = code;
    this.description = description;
    this.parameters = parameters;
  }
}

export class EndpointError extends Error {
  constructor(description, parameters = {}) {
    super(description);
    this.description = description;
    this.parameters = parameters;
  }
}

export class InputFile {
  constructor(bytes, name, opts = {}) {
    Object.assign(this, { bytes, name, type: opts.type });
  }
}

let nextMessageId = 1000;

// Each call is { method, params }. Set api.failures[method] = (params) => error|null
// to make a call fail.
export const calls = [];
export const failures = {};

const results = {
  getMe: () => ({ id: 1, is_bot: true, first_name: 'Benaiah', username: 'BenaiahTestBot' }),
  sendMessage: (p) => ({ message_id: nextMessageId++, chat: { id: p.chat_id }, text: p.text }),
  sendPhoto: (p) => ({ message_id: nextMessageId++, chat: { id: p.chat_id }, photo: [{}], caption: p.caption }),
  sendRichMessage: (p) => ({ message_id: nextMessageId++, chat: { id: p.chat_id } }),
  sendMediaGroup: (p) => p.media.map((m) => {
    const id = nextMessageId++;
    return m.type === 'document'
      ? { message_id: id, chat: { id: p.chat_id }, document: { file_id: typeof m.media === 'string' ? m.media : `file-${id}` } }
      : { message_id: id, chat: { id: p.chat_id }, photo: [{}] };
  }),
  sendDocument: (p) => ({ message_id: nextMessageId, chat: { id: p.chat_id }, document: { file_id: typeof p.document === 'string' ? p.document : `file-${nextMessageId++}` } }),
  copyMessage: () => ({ message_id: nextMessageId++ }),
  forwardMessage: (p) => ({ message_id: nextMessageId++, chat: { id: p.chat_id } }),
  savePreparedInlineMessage: () => ({ id: `prepared-${nextMessageId++}`, expiration_date: Math.floor(Date.now() / 1000) + 86400 }),
  copyMessages: (p) => p.message_ids.map(() => ({ message_id: nextMessageId++ })),
};

export const api = new Proxy({}, {
  get(_, method) {
    if (method === 'then') return undefined;
    return async (params = {}) => {
      calls.push({ method, params });
      const fail = failures[method]?.(params);
      if (fail) throw fail;
      return results[method] ? results[method](params) : true;
    };
  },
});

export function resetCalls() {
  calls.length = 0;
}

export const fetch = globalThis.fetch;
export default { db, api, fetch };
