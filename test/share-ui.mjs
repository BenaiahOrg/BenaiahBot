// The actual sharing screen against a fake Telegram bridge. Nothing is sent.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { t } from '../tgcloud/lib/i18n.js';

const source = fs.readFileSync(new URL('../webapp/share.js', import.meta.url), 'utf8');

async function openScreen({ supported = true, expiresAt = Math.floor(Date.now() / 1000) + 1000, error } = {}) {
  const elements = Object.fromEntries(['title', 'status', 'share', 'close'].map((id) => [id, { hidden: id === 'share' || id === 'close', textContent: '', disabled: false }]));
  let preparations = 0;
  let chooserCalls = 0;
  let closed = 0;
  let sent = false;
  const prepared = { id: 'prepared-test', title: 'Jehovah Jireh', expiresAt, ui: t('en', 'sharingUi') };
  const tg = {
    initData: 'verified-by-bridge', ready() {},
    isVersionAtLeast: () => supported,
    close: () => { closed++; },
    Serverless: { call(name, input, callback) {
      assert.equal(name, 'prepareArticleShare');
      assert.equal(input.lang, 'en');
      preparations++;
      callback(error, { ...prepared, expiresAt: preparations > 1 ? Math.floor(Date.now() / 1000) + 1000 : expiresAt });
    } },
    shareMessage(id, callback) {
      assert.equal(id, 'prepared-test');
      chooserCalls++;
      callback(sent);
    },
  };
  await vm.runInNewContext(source, { window: { Telegram: { WebApp: tg } }, document: { getElementById: (id) => elements[id] },
    URLSearchParams, location: { search: '?theme=names-of-god&subtopic=jehovah-jireh&type=devotional&lang=en&uiLang=en' } });
  return { elements, counts: () => ({ preparations, chooserCalls, closed }), markSent: () => { sent = true; } };
}

export async function verifyShareScreen() {
  const screen = await openScreen();
  assert.equal(screen.elements.title.textContent, 'Jehovah Jireh');
  assert.equal(screen.elements.status.textContent, t('en', 'sharingUi').cancelled);
  assert.equal(screen.elements.share.disabled, false);
  assert.equal(screen.counts().closed, 0, 'cancel leaves the screen open for another attempt');
  screen.markSent();
  await screen.elements.share.onclick();
  assert.equal(screen.counts().chooserCalls, 2);
  assert.equal(screen.counts().closed, 1, 'successful sharing closes the screen');
  const oldClient = await openScreen({ supported: false });
  assert.equal(oldClient.counts().chooserCalls, 0);
  assert.equal(oldClient.elements.share.hidden, true);
  assert.equal(oldClient.elements.status.textContent, t('en', 'sharingUi').updateTelegram);
  const expired = await openScreen({ expiresAt: 1 });
  assert.equal(expired.counts().preparations, 2, 'refresh an expired prepared message before sharing');
  const failed = await openScreen({ error: { message: 'Article unavailable' } });
  assert.equal(failed.elements.status.textContent, 'Article unavailable');
  assert.equal(failed.counts().chooserCalls, 0);
}
