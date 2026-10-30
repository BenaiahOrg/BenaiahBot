// Admin dashboard. Talks to tgcloud/endpoints/admin*.js through
// Telegram.WebApp.Serverless.call, which sends the verified init data.
(function () {
  const tg = window.Telegram && window.Telegram.WebApp;
  const state = { data: null, tab: 'overview' };

  const $ = (id) => document.getElementById(id);

  // Builds DOM without innerHTML, so names from the database can't inject markup.
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
      else if (key === 'style') el.style.cssText = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  function call(name, input) {
    return new Promise((resolve, reject) => {
      tg.Serverless.call(name, input || {}, (err, result) => (err ? reject(err) : resolve(result)));
    });
  }

  const nf = new Intl.NumberFormat('en');
  const fmt = (n) => (n == null ? '—' : nf.format(n));
  const pct = (n) => (n == null ? '—' : `${Math.round(n * 100)}%`);

  function duration(ms) {
    if (ms == null) return '—';
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`;
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h ${minutes % 60}m`;
    return `${Math.round(hours / 24)}d`;
  }

  function ago(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    return `${duration(diff)} ago`;
  }

  const LANG = { en: 'English', am: 'Amharic' };

  const STATUS = {
    intro: ['Writing', ''],
    searching: ['Offered', 'info'],
    waiting: ['Queued', 'warn'],
    active: ['Live', 'good'],
    ended: ['Ended', ''],
    cancelled: ['Cancelled', ''],
    accepted: ['Accepted', 'good'],
    declined: ['Declined', 'bad'],
    expired: ['No answer', 'warn'],
    pending: ['Pending', 'info'],
    failed: ['Unreachable', 'bad'],
  };

  function badge(status) {
    const [label, tone] = STATUS[status] || [status, ''];
    return h('span', { class: `badge ${tone}` }, label);
  }

  function tile(label, value, note) {
    return h('div', { class: 'tile' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value),
      note ? h('div', { class: 'note' }, note) : null);
  }

  function chart(title, series) {
    const max = Math.max(1, ...series.map((d) => d.n));
    const total = series.reduce((sum, d) => sum + d.n, 0);
    const short = (day) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    return h('div', { class: 'card' },
      h('div', { class: 'chart-head' }, h('span', {}, title), h('strong', {}, fmt(total))),
      h('div', { class: 'chart', role: 'img', 'aria-label': `${title}: ${total} in 14 days` },
        series.map((d) => h('span', {
          class: d.n ? '' : 'zero',
          style: `height:${Math.max(3, (d.n / max) * 100)}%`,
          title: `${short(d.day)}: ${d.n}`,
        }))),
      h('div', { class: 'axis' }, h('span', {}, short(series[0].day)), h('span', {}, 'today')));
  }

  function barList(items, label) {
    if (!items.length) return h('div', { class: 'card empty' }, 'Nothing yet.');
    const max = Math.max(...items.map((i) => i.n));
    return h('div', { class: 'card' }, h('ul', { class: 'bar-list' }, items.map((item) =>
      h('li', {},
        h('span', { class: 'name', title: item.key }, label ? label(item.key) : item.key),
        h('span', { class: 'n' }, fmt(item.n)),
        h('span', { class: 'track' }, h('i', { style: `width:${(item.n / max) * 100}%` }))))));
  }

  function renderOverview(d) {
    const c = d.counseling;
    const offered = c.accepted + c.declined + c.expired;
    $('overview').replaceChildren(
      h('h3', {}, 'People'),
      h('div', { class: 'tiles' },
        tile('Users', fmt(d.users.total), `EN ${fmt(d.users.byLang.en || 0)} · AM ${fmt(d.users.byLang.am || 0)}`),
        tile('New this week', fmt(d.users.newWeek), `${fmt(d.users.newMonth)} in 30 days`),
        tile('Active this week', fmt(d.users.activeWeek), d.users.blocked ? `${fmt(d.users.blocked)} blocked the bot` : 'opened the bot'),
        tile('Articles read', fmt(d.content.byKind.article?.total || 0), `${fmt(d.content.byKind.article?.week || 0)} this week`)),
      h('h3', {}, 'Counseling'),
      h('div', { class: 'tiles' },
        tile('Live now', fmt(c.byStatus.active || 0), `${fmt(c.byStatus.waiting || 0)} queued · ${fmt(c.byStatus.searching || 0)} offered`),
        tile('Requests', fmt(c.requests), `${fmt(c.byStatus.ended || 0)} completed`),
        tile('Accept rate', offered ? pct(c.accepted / offered) : '—', `${fmt(c.accepted)} ✓ · ${fmt(c.declined)} ✕ · ${fmt(c.expired)} ⌛`),
        tile('Rating', c.avgRating == null ? '—' : `${c.avgRating.toFixed(1)} ★`, `${fmt(c.ratings)} ratings`),
        tile('Avg wait', duration(c.avgWaitMs), 'request → accepted'),
        tile('Avg session', duration(c.avgSessionMs), `${fmt(c.messages)} messages relayed`),
        tile('Counselors', fmt(c.counselors), `${fmt(c.counselorsAvailable)} free now`)),
      h('h3', {}, 'Last 14 days'),
      chart('New users', d.series.users),
      chart('Articles read', d.series.reads),
      chart('Counseling requests', d.series.requests));
  }

  function counselorCard(c) {
    const badges = [];
    if (!c.linked) badges.push(h('span', { class: 'badge warn', title: 'Added by @username; becomes reachable once they open the bot' }, 'Hasn’t opened bot'));
    badges.push(c.active ? h('span', { class: 'badge good' }, 'Available') : h('span', { class: 'badge' }, 'Paused'));
    if (c.busy) badges.push(h('span', { class: 'badge info' }, 'In session'));
    if (c.pending) badges.push(h('span', { class: 'badge info' }, 'Offer pending'));
    const handle = [c.username ? `@${c.username}` : null, c.userId ? `id ${c.userId}` : null].filter(Boolean).join(' · ');
    return h('div', { class: 'card counselor' },
      h('div', { class: 'counselor-head' },
        h('div', { class: 'who' }, h('strong', {}, c.displayName || handle), h('span', {}, handle)),
        h('div', { class: 'badges' }, badges)),
      h('div', { class: 'metrics' },
        metric(fmt(c.accepted), 'accepted'),
        metric(fmt(c.declined), 'declined'),
        metric(fmt(c.expired), 'no answer'),
        metric(pct(c.acceptRate), 'accept rate'),
        metric(fmt(c.sessions), 'sessions'),
        metric(c.avgRating == null ? '—' : `${c.avgRating.toFixed(1)}★`, `${c.ratings} ratings`),
        metric(duration(c.avgResponseMs), 'responds in'),
        metric(duration(c.avgSessionMs), 'avg session')),
      h('div', { class: 'actions' },
        h('button', { onclick: () => save({ action: 'update', id: c.id, active: !c.active }) }, c.active ? 'Pause' : 'Resume'),
        h('button', { onclick: () => rename(c) }, 'Rename'),
        h('button', { class: 'danger', onclick: () => remove(c) }, 'Remove'),
        h('button', { class: 'link', onclick: () => openCounselor(c.id) }, 'History ›')));
  }

  function metric(value, label) {
    return h('div', { class: 'metric' }, h('b', {}, value), h('small', {}, label));
  }

  function renderCounselors(list) {
    $('counselor-list').replaceChildren(
      h('h3', {}, `Counselors (${list.length})`),
      ...(list.length ? list.map(counselorCard) : [h('div', { class: 'card empty' }, 'No counselors yet. Add the first one above.')]));
  }

  function renderRequests(rows) {
    $('requests').replaceChildren(
      h('h3', {}, 'Recent sessions'),
      h('p', { class: 'hint', style: 'margin:0 4px 10px' }, 'Requests are anonymous here too: nobody’s identity or messages are stored.'),
      rows.length ? h('div', { class: 'card' }, rows.map((r) => h('div', { class: 'list-row' },
        h('span', { class: 'id' }, `#${r.id}`),
        h('div', { class: 'main' },
          h('div', {}, r.counselor ? r.counselor : r.status === 'cancelled' ? 'Cancelled before pickup' : r.status === 'intro' ? 'Writing their first message' : 'Not picked up yet'),
          h('small', {}, [
            LANG[r.lang] || r.lang,
            ago(r.createdAt),
            r.waitMs != null ? `waited ${duration(r.waitMs)}` : `${r.offers} offer${r.offers === 1 ? '' : 's'}`,
            r.durationMs != null ? `lasted ${duration(r.durationMs)}` : null,
            r.userMessages + r.counselorMessages ? `${r.userMessages + r.counselorMessages} msgs` : null,
          ].filter(Boolean).join(' · '))),
        h('div', { class: 'side' }, badge(r.status), r.rating ? h('div', {}, '★'.repeat(r.rating)) : null))))
        : h('div', { class: 'card empty' }, 'No counseling requests yet.'));
  }

  // "names-of-god/jehovah-jireh/devotional_en" → "Jehovah Jireh · Devotional · EN"
  function articleLabel(key) {
    const [, subtopic, slug] = String(key).split('/');
    if (!slug) return key;
    const title = subtopic.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const [, type, lang] = /^(.*)_(en|am)$/.exec(slug) || [null, slug, ''];
    return `${title} · ${type === 'study_material' ? 'Study' : 'Devotional'} · ${lang.toUpperCase()}`;
  }

  function renderContent(d) {
    const k = d.content.byKind;
    const row = (kind) => k[kind] || { total: 0, week: 0 };
    $('content').replaceChildren(
      h('h3', {}, 'Engagement'),
      h('div', { class: 'tiles' },
        tile('Articles read', fmt(row('article').total), `${fmt(row('article').week)} this week`),
        tile('Topics opened', fmt(row('subtopic').total), `${fmt(row('subtopic').week)} this week`),
        tile('Graphics viewed', fmt(row('graphics').total), `${fmt(row('graphics').week)} this week`),
        tile('Searches', fmt(row('search').total), `${fmt(row('random').total)} random devotionals`)),
      h('h3', {}, 'Most read'),
      barList(d.content.topArticles, articleLabel),
      h('h3', {}, 'Top searches'),
      barList(d.content.topSearches),
      h('h3', {}, 'Reading language'),
      barList(Object.entries(d.users.byLang).map(([key, n]) => ({ key: LANG[key] || 'Not chosen yet', n })).sort((a, b) => b.n - a.n)));
  }

  function render() {
    const d = state.data;
    if (!d) return;
    $('updated').textContent = `Updated ${new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    renderOverview(d);
    renderCounselors(d.counselors);
    renderRequests(d.requests);
    renderContent(d);
  }

  function showError(err) {
    const message = (err && (err.message || err.description)) || 'Something went wrong.';
    if (tg.showAlert) tg.showAlert(message);
    else alert(message);
  }

  async function load() {
    $('refresh').classList.add('spin');
    try {
      state.data = await call('adminDashboard');
      render();
    } catch (err) {
      if (err && err.parameters && err.parameters.code === 'FORBIDDEN') {
        $('blocked').hidden = false;
        $('blocked').querySelector('p').textContent = 'Your account isn’t on the admin list (ADMIN_IDS).';
      } else showError(err);
    } finally {
      $('refresh').classList.remove('spin');
    }
  }

  async function save(input) {
    try {
      const result = await call('adminCounselorSave', input);
      if (state.data) state.data.counselors = result.counselors;
      renderCounselors(result.counselors);
      if (tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
      return result;
    } catch (err) {
      showError(err);
      throw err;
    }
  }

  function confirmDialog(text) {
    return new Promise((resolve) => (tg.showConfirm ? tg.showConfirm(text, resolve) : resolve(window.confirm(text))));
  }

  function rename(c) {
    const next = window.prompt('Display name (only admins see it)', c.displayName || '');
    if (next != null && next.trim() !== c.displayName) save({ action: 'update', id: c.id, displayName: next.trim() }).catch(() => {});
  }

  async function remove(c) {
    const busy = c.busy ? ' Their live session will go back to the queue.' : '';
    if (await confirmDialog(`Remove ${c.displayName || 'this counselor'}?${busy} Their history stays in the stats.`)) {
      save({ action: 'remove', id: c.id }).catch(() => {});
    }
  }

  async function openCounselor(id) {
    $('sheet-content').replaceChildren(h('div', { class: 'skeleton' }));
    $('sheet').hidden = false;
    try {
      const { counselor: c, history } = await call('adminCounselor', { id });
      $('sheet-content').replaceChildren(
        h('h2', {}, c.displayName),
        h('p', { class: 'hint' }, [c.username ? `@${c.username}` : null, c.userId ? `id ${c.userId}` : null, `added ${ago(c.createdAt)}`, `last offer ${ago(c.lastOfferAt)}`].filter(Boolean).join(' · ')),
        h('h3', {}, 'Totals'),
        h('div', { class: 'card' }, h('div', { class: 'metrics' },
          metric(fmt(c.offers), 'offers'),
          metric(fmt(c.accepted), 'accepted'),
          metric(fmt(c.declined), 'declined'),
          metric(fmt(c.expired), 'no answer'),
          metric(fmt(c.sessions), 'sessions'),
          metric(fmt(c.messagesSent), 'msgs sent'),
          metric(duration(c.avgResponseMs), 'responds in'),
          metric(c.avgRating == null ? '—' : `${c.avgRating.toFixed(1)}★`, `${c.ratings} ratings`))),
        h('h3', {}, 'Recent offers'),
        history.length ? h('div', { class: 'card' }, history.map((o) => h('div', { class: 'list-row' },
          h('span', { class: 'id' }, `#${o.requestId}`),
          h('div', { class: 'main' },
            h('div', {}, o.live ? 'Live now' : LANG[o.lang] || o.lang || ''),
            h('small', {}, [
              ago(o.createdAt),
              o.responseMs != null ? `answered in ${duration(o.responseMs)}` : null,
              o.durationMs != null ? `lasted ${duration(o.durationMs)}` : null,
              o.messages ? `${o.messages} msgs` : null,
            ].filter(Boolean).join(' · '))),
          h('div', { class: 'side' }, badge(o.status), o.rating ? h('div', {}, '★'.repeat(o.rating)) : null))))
          : h('div', { class: 'card empty' }, 'No offers yet.'));
    } catch (err) {
      $('sheet').hidden = true;
      showError(err);
    }
  }

  function selectTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== tab; });
    window.scrollTo({ top: 0 });
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
  $('refresh').addEventListener('click', load);
  $('sheet-close').addEventListener('click', () => { $('sheet').hidden = true; });
  $('sheet').addEventListener('click', (e) => { if (e.target === $('sheet')) $('sheet').hidden = true; });

  $('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = e.submitter || $('add').querySelector('button');
    const error = $('add-error');
    error.hidden = true;
    button.disabled = true;
    try {
      const result = await call('adminCounselorSave', { action: 'add', handle: $('handle').value, displayName: $('name').value });
      if (state.data) state.data.counselors = result.counselors;
      renderCounselors(result.counselors);
      $('handle').value = '';
      $('name').value = '';
      error.hidden = false;
      error.style.color = 'var(--good)';
      error.textContent = result.reachable
        ? 'Added and notified.'
        : 'Added. They’ll be notified and start receiving requests once they open the bot.';
    } catch (err) {
      error.hidden = false;
      error.style.color = '';
      error.textContent = err.message || 'Could not add that counselor.';
    } finally {
      button.disabled = false;
    }
  });

  if (!tg || !tg.initData || !tg.Serverless) {
    $('blocked').hidden = false;
    return;
  }
  tg.ready();
  tg.expand();
  $('overview').replaceChildren(h('div', { class: 'tiles' }, [1, 2, 3, 4].map(() => h('div', { class: 'skeleton' }))));
  load();
})();
