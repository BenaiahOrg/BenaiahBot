(async function () {
  const tg = window.Telegram?.WebApp;
  const $ = (id) => document.getElementById(id);
  if (!tg?.initData || !tg.Serverless) return;
  tg.ready();
  const params = new URLSearchParams(location.search);
  const input = Object.fromEntries(['theme', 'subtopic', 'type', 'lang', 'uiLang'].map((key) => [key, params.get(key)]));
  let prepared;
  const prepare = () => new Promise((resolve, reject) => {
    tg.Serverless.call('prepareArticleShare', input, (err, result) => err ? reject(err) : resolve(result));
  });
  async function share() {
    $('share').disabled = true;
    try {
      if (Date.now() >= prepared.expiresAt * 1000) prepared = await prepare();
      tg.shareMessage(prepared.id, (sent) => {
        if (sent) tg.close();
        else {
          $('status').textContent = prepared.ui.cancelled;
          $('share').disabled = false;
        }
      });
    } catch (err) {
      $('status').textContent = err.message || prepared.ui.failed;
      $('share').disabled = false;
    }
  }
  try {
    prepared = await prepare();
    $('title').textContent = prepared.title;
    $('status').textContent = prepared.ui.intro;
    $('close').textContent = prepared.ui.close;
    $('close').hidden = false;
    $('close').onclick = () => tg.close();
    if (!tg.isVersionAtLeast('8.0') || typeof tg.shareMessage !== 'function') {
      $('status').textContent = prepared.ui.updateTelegram;
      return;
    }
    $('share').textContent = prepared.ui.share;
    $('share').hidden = false;
    $('share').onclick = share;
    await share();
  } catch (err) {
    $('status').textContent = err.message;
  }
})();
