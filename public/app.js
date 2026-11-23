'use strict';

(() => {
  const app = document.getElementById('app');
  const dialog = document.getElementById('practice-dialog');
  const form = document.getElementById('practice-form');
  const formError = document.getElementById('practice-error');

  const STATUS_LABEL = { yes: '参加', maybe: '未定', no: '不参加' };
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

  let adminRequired = false;
  let editingId = null;

  // ---------- utilities ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const storage = {
    get(k, area = localStorage) { try { return area.getItem(k) || ''; } catch { return ''; } },
    set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* ignore */ } },
    del(k, area = localStorage) { try { area.removeItem(k); } catch { /* ignore */ } },
  };

  // ---------- 管理者セッション（このタブを閉じるまで有効） ----------
  const admin = {
    password: () => storage.get('adminPassword', sessionStorage),
    loggedIn: () => storage.get('adminMode', sessionStorage) === '1',
    login(pw = '') {
      storage.set('adminMode', '1', sessionStorage);
      if (pw) storage.set('adminPassword', pw, sessionStorage);
      updateNav();
    },
    logout() {
      storage.del('adminMode', sessionStorage);
      storage.del('adminPassword', sessionStorage);
      updateNav();
    },
  };

  function formatDate(p) {
    const [y, m, d] = p.date.split('-').map(Number);
    const wd = WEEKDAYS[new Date(y, m - 1, d).getDay()];
    let s = `${y}年${m}月${d}日(${wd})`;
    if (p.startTime) s += ` ${p.startTime}${p.endTime ? `〜${p.endTime}` : '〜'}`;
    else if (p.endTime) s += ` 〜${p.endTime}`;
    return s;
  }

  function counts(p) {
    const c = { yes: 0, maybe: 0, no: 0 };
    for (const r of p.responses) c[r.status]++;
    return c;
  }

  function countPills(p) {
    const c = counts(p);
    return `<div class="counts">
      <span class="pill yes">参加 ${c.yes}</span>
      <span class="pill maybe">未定 ${c.maybe}</span>
      <span class="pill no">不参加 ${c.no}</span>
    </div>`;
  }

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2500);
  }

  async function api(path, { method = 'GET', body, asAdmin = false, password } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (asAdmin) headers['X-Admin-Password'] = password ?? admin.password();
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && asAdmin && password === undefined) {
      // パスワードが変わった等でセッションが無効になった
      admin.logout();
      location.hash = '#/admin';
      throw new Error('もう一度ログインしてください');
    }
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    return data;
  }

  // ---------- navigation ----------
  function updateNav() {
    document.querySelector('[data-tab="admin"]').hidden = !admin.loggedIn();
  }

  function setTab(name) {
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  }

  // ---------- member views ----------
  function practiceCard(p) {
    const meta = [formatDate(p), p.location].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join('');
    return `<a class="card practice-link" href="#/p/${encodeURIComponent(p.id)}">
      <p class="practice-title">${esc(p.title)}</p>
      <div class="meta">${meta}</div>
      ${countPills(p)}
    </a>`;
  }

  async function renderList(archived) {
    setTab(archived ? 'archive' : 'upcoming');
    app.innerHTML = '<p class="empty">読み込み中…</p>';
    const { practices } = await api(`/api/practices?archived=${archived}`);
    const head = archived
      ? `<div class="toolbar"><h1>アーカイブ（過去の練習）</h1></div>
         <p class="hint">終了日時を過ぎた練習は自動でここに移動します。</p>`
      : `<div class="toolbar"><h1>予定の練習</h1></div>`;
    const body = practices.length
      ? practices.map(practiceCard).join('')
      : `<p class="empty">${archived ? 'アーカイブされた練習はまだありません' : '予定されている練習はありません'}</p>`;
    app.innerHTML = head + body;
  }

  async function renderDetail(id) {
    app.innerHTML = '<p class="empty">読み込み中…</p>';
    let practice;
    try {
      ({ practice } = await api(`/api/practices/${encodeURIComponent(id)}`));
    } catch (err) {
      app.innerHTML = `<a class="back" href="#/">← 一覧へ</a><p class="empty">${esc(err.message)}</p>`;
      return;
    }
    const p = practice;
    const isAdmin = admin.loggedIn();
    setTab(p.archived ? 'archive' : 'upcoming');
    const myName = storage.get('name');
    const mine = p.responses.find((r) => r.name.toLowerCase() === myName.toLowerCase());

    const order = { yes: 0, maybe: 1, no: 2 };
    const rows = [...p.responses]
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'ja'))
      .map((r) => `<li class="response">
        <span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span>
        <span class="response-name">${esc(r.name)}</span>
        ${isAdmin ? `<button class="small danger" data-del-response="${esc(r.id)}" aria-label="${esc(r.name)}の回答を削除">削除</button>` : '<span></span>'}
        ${r.comment ? `<p class="response-comment">${esc(r.comment)}</p>` : ''}
      </li>`)
      .join('');

    const responseForm = p.archived
      ? `<p class="hint">この練習はアーカイブ済みのため、出欠の回答は締め切られています。</p>`
      : `<form id="response-form" class="card">
          <h2 class="card-heading">出欠を回答</h2>
          <label>名前<input name="name" required maxlength="50" value="${esc(mine?.name || myName)}" autocomplete="name"></label>
          <div class="status-choice" role="radiogroup" aria-label="出欠">
            ${['yes', 'maybe', 'no'].map((s) => `<label><input type="radio" name="status" value="${s}" ${(mine?.status || 'yes') === s ? 'checked' : ''}><span>${STATUS_LABEL[s]}</span></label>`).join('')}
          </div>
          <label>コメント（任意）<input name="comment" maxlength="300" value="${esc(mine?.comment || '')}" placeholder="例: 30分遅れます"></label>
          <p class="hint">同じ名前で回答すると上書きされます。</p>
          <p class="error" id="response-error" hidden></p>
          <div class="actions"><button type="submit">${mine ? '回答を更新' : '回答する'}</button></div>
        </form>`;

    app.innerHTML = `
      <a class="back" href="${p.archived ? '#/archive' : '#/'}">← ${p.archived ? 'アーカイブ' : '予定の練習'}へ</a>
      <div class="card">
        ${p.archived ? `<span class="pill archived">${p.autoArchived ? '自動アーカイブ済み' : 'アーカイブ済み'}</span>` : ''}
        <h1 class="practice-title detail-title">${esc(p.title)}</h1>
        <div class="meta"><span>${esc(formatDate(p))}</span>${p.location ? `<span>${esc(p.location)}</span>` : ''}</div>
        ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
        ${countPills(p)}
        ${isAdmin ? '<div class="actions top-gap"><a class="button secondary small" href="#/admin">管理者メニューで編集</a></div>' : ''}
      </div>
      ${responseForm}
      <div class="card">
        <h2 class="card-heading">回答一覧（${p.responses.length}人）</h2>
        ${p.responses.length ? `<ul class="responses">${rows}</ul>` : '<p class="hint">まだ回答がありません</p>'}
      </div>`;

    const responseFormEl = document.getElementById('response-form');
    responseFormEl?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(responseFormEl).entries());
      const errEl = document.getElementById('response-error');
      try {
        await api(`/api/practices/${encodeURIComponent(p.id)}/responses`, { method: 'POST', body });
        storage.set('name', body.name.trim());
        toast('回答しました');
        renderDetail(p.id);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
      }
    });

    app.querySelectorAll('[data-del-response]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        if (!confirm('この回答を削除しますか？')) return;
        try {
          await api(`/api/practices/${encodeURIComponent(p.id)}/responses/${encodeURIComponent(btn.dataset.delResponse)}`, { method: 'DELETE', asAdmin: true });
          renderDetail(p.id);
        } catch (err) { toast(err.message); }
      }));
  }

  // ---------- admin views ----------
  function renderLogin() {
    setTab('admin');
    app.innerHTML = `
      <div class="toolbar"><h1>管理者メニュー</h1></div>
      <form id="login-form" class="card narrow">
        <h2 class="card-heading">ログイン</h2>
        <label>管理者パスワード<input name="password" type="password" required autocomplete="current-password"></label>
        <p class="error" id="login-error" hidden></p>
        <div class="actions"><button type="submit">ログイン</button></div>
      </form>`;
    const f = document.getElementById('login-form');
    f.elements.password.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = f.elements.password.value;
      try {
        await api('/api/admin/check', { method: 'POST', asAdmin: true, password: pw });
        admin.login(pw);
        toast('ログインしました');
        renderAdmin();
      } catch {
        const el = document.getElementById('login-error');
        el.textContent = 'パスワードが違います';
        el.hidden = false;
      }
    });
  }

  function adminRow(p) {
    const meta = [formatDate(p), p.location].filter(Boolean).map((s) => `<span>${esc(s)}</span>`).join('');
    const id = esc(p.id);
    return `<div class="card admin-row">
      <a class="practice-title" href="#/p/${encodeURIComponent(p.id)}">${esc(p.title)}</a>
      <div class="meta">${meta}</div>
      ${countPills(p)}
      <div class="actions top-gap">
        <button class="small secondary" data-act="edit" data-id="${id}">編集</button>
        ${p.archived
          ? `<button class="small secondary" data-act="unarchive" data-id="${id}">予定に戻す</button>`
          : `<button class="small secondary" data-act="archive" data-id="${id}">アーカイブ</button>`}
        <button class="small danger" data-act="delete" data-id="${id}">削除</button>
      </div>
    </div>`;
  }

  async function renderAdmin() {
    if (adminRequired && !admin.password()) {
      admin.logout();
      return renderLogin();
    }
    if (!adminRequired) admin.login();
    setTab('admin');
    app.innerHTML = '<p class="empty">読み込み中…</p>';
    const [{ practices: upcoming }, { practices: archived }] = await Promise.all([
      api('/api/practices?archived=false'),
      api('/api/practices?archived=true'),
    ]);
    const byId = new Map([...upcoming, ...archived].map((p) => [p.id, p]));

    app.innerHTML = `
      <div class="toolbar">
        <h1>管理者メニュー</h1>
        <div class="actions">
          <button id="add-btn">＋ 練習を追加</button>
          ${adminRequired ? '<button class="secondary" id="logout-btn">ログアウト</button>' : ''}
        </div>
      </div>
      ${adminRequired ? '' : '<p class="warning">管理者パスワードが設定されていないため、誰でもこのメニューを使えます。環境変数 <code>ADMIN_PASSWORD</code> を設定してください。</p>'}
      <h2 class="section-heading">予定の練習（${upcoming.length}件）</h2>
      ${upcoming.length ? upcoming.map(adminRow).join('') : '<p class="empty">予定されている練習はありません</p>'}
      <h2 class="section-heading">アーカイブ（${archived.length}件）</h2>
      ${archived.length ? archived.map(adminRow).join('') : '<p class="empty">アーカイブされた練習はまだありません</p>'}`;

    document.getElementById('add-btn').addEventListener('click', () => openDialog());
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      admin.logout();
      toast('ログアウトしました');
      location.hash = '#/';
    });

    app.querySelectorAll('[data-act]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const p = byId.get(btn.dataset.id);
        const base = `/api/practices/${encodeURIComponent(p.id)}`;
        try {
          switch (btn.dataset.act) {
            case 'edit':
              return openDialog(p);
            case 'archive':
              if (!confirm(`「${p.title}」をアーカイブしますか？`)) return;
              await api(`${base}/archive`, { method: 'POST', asAdmin: true });
              toast('アーカイブしました');
              break;
            case 'unarchive':
              await api(`${base}/unarchive`, { method: 'POST', asAdmin: true });
              toast('予定に戻しました');
              break;
            case 'delete':
              if (!confirm(`「${p.title}」を削除しますか？（回答も含めて元に戻せません）`)) return;
              await api(base, { method: 'DELETE', asAdmin: true });
              toast('削除しました');
              break;
          }
          renderAdmin();
        } catch (err) { toast(err.message); }
      }));
  }

  // ---------- dialog ----------
  function openDialog(p = null) {
    editingId = p?.id || null;
    document.getElementById('practice-dialog-title').textContent = p ? '練習を編集' : '練習を追加';
    form.reset();
    formError.hidden = true;
    for (const k of ['title', 'date', 'startTime', 'endTime', 'location', 'note']) {
      form.elements[k].value = p ? p[k] || '' : '';
    }
    if (!p) {
      const t = new Date();
      form.elements.date.value = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    }
    dialog.showModal();
  }

  dialog.querySelector('[data-close]').addEventListener('click', () => dialog.close());

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    try {
      const { practice } = editingId
        ? await api(`/api/practices/${encodeURIComponent(editingId)}`, { method: 'PUT', body, asAdmin: true })
        : await api('/api/practices', { method: 'POST', body, asAdmin: true });
      dialog.close();
      toast(practice.archived ? '終了日時を過ぎているため、アーカイブに保存しました' : '保存しました');
      renderAdmin();
    } catch (err) {
      formError.textContent = err.message;
      formError.hidden = false;
    }
  });

  // ---------- router ----------
  async function route() {
    const hash = location.hash || '#/';
    try {
      const m = hash.match(/^#\/p\/(.+)$/);
      if (m) return await renderDetail(decodeURIComponent(m[1]));
      if (hash === '#/admin') return await renderAdmin();
      if (hash === '#/archive') return await renderList(true);
      return await renderList(false);
    } catch (err) {
      app.innerHTML = `<p class="empty error">${esc(err.message)}</p>`;
    }
  }

  window.addEventListener('hashchange', route);

  api('/api/config')
    .then((c) => { adminRequired = c.adminRequired; })
    .catch(() => {})
    .finally(() => { updateNav(); route(); });
})();
