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

  async function api(path, { method = 'GET', body, admin = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (admin && adminRequired) {
      let pw = storage.get('adminPassword', sessionStorage);
      if (!pw) {
        pw = prompt('管理者パスワードを入力してください') || '';
        if (!pw) throw new Error('キャンセルしました');
      }
      headers['X-Admin-Password'] = pw;
      const res = await fetch(path, { method, headers, body: body && JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        storage.del('adminPassword', sessionStorage);
        throw new Error(data.error || 'パスワードが違います');
      }
      storage.set('adminPassword', pw, sessionStorage);
      if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
      return data;
    }
    const res = await fetch(path, { method, headers, body: body && JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
    return data;
  }

  // ---------- views ----------
  function setTab(name) {
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  }

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
      : `<div class="toolbar"><h1>予定の練習</h1><button id="add-btn">＋ 練習を追加</button></div>`;
    const body = practices.length
      ? practices.map(practiceCard).join('')
      : `<p class="empty">${archived ? 'アーカイブされた練習はまだありません' : '予定されている練習はありません'}</p>`;
    app.innerHTML = head + body;
    document.getElementById('add-btn')?.addEventListener('click', () => openDialog());
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
    setTab(p.archived ? 'archive' : 'upcoming');
    const myName = storage.get('name');
    const mine = p.responses.find((r) => r.name.toLowerCase() === myName.toLowerCase());

    const order = { yes: 0, maybe: 1, no: 2 };
    const rows = [...p.responses]
      .sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, 'ja'))
      .map((r) => `<tr>
        <td>${esc(r.name)}</td>
        <td><span class="pill ${r.status}">${STATUS_LABEL[r.status]}</span></td>
        <td class="comment">${esc(r.comment)}</td>
        ${p.archived ? '' : `<td><button class="small danger" data-del-response="${esc(r.id)}" aria-label="${esc(r.name)}の回答を削除">削除</button></td>`}
      </tr>`)
      .join('');

    const responseForm = p.archived
      ? `<p class="hint">この練習はアーカイブ済みのため、出欠の回答は締め切られています。</p>`
      : `<form id="response-form" class="card">
          <h2 style="margin-top:0;font-size:1.05rem">出欠を回答</h2>
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
        <h1 class="practice-title" style="font-size:1.3rem">${esc(p.title)}</h1>
        <div class="meta"><span>${esc(formatDate(p))}</span>${p.location ? `<span>${esc(p.location)}</span>` : ''}</div>
        ${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}
        ${countPills(p)}
        <div class="actions" style="margin-top:12px">
          ${p.archived
            ? '<button class="small secondary" id="unarchive-btn">予定に戻す</button>'
            : '<button class="small secondary" id="edit-btn">編集</button><button class="small secondary" id="archive-btn">アーカイブ</button>'}
          <button class="small danger" id="delete-btn">削除</button>
        </div>
      </div>
      ${responseForm}
      <div class="card">
        <h2 style="margin-top:0;font-size:1.05rem">回答一覧（${p.responses.length}人）</h2>
        ${p.responses.length
          ? `<table class="responses"><thead><tr><th>名前</th><th>出欠</th><th>コメント</th>${p.archived ? '' : '<th></th>'}</tr></thead><tbody>${rows}</tbody></table>`
          : '<p class="hint">まだ回答がありません</p>'}
      </div>`;

    const responseFormEl = document.getElementById('response-form');
    responseFormEl?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(responseFormEl);
      const body = Object.fromEntries(fd.entries());
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
          await api(`/api/practices/${encodeURIComponent(p.id)}/responses/${encodeURIComponent(btn.dataset.delResponse)}`, { method: 'DELETE' });
          renderDetail(p.id);
        } catch (err) { toast(err.message); }
      }));

    document.getElementById('edit-btn')?.addEventListener('click', () => openDialog(p));

    const adminAction = (btnId, path, method, confirmMsg, after) => {
      document.getElementById(btnId)?.addEventListener('click', async () => {
        if (confirmMsg && !confirm(confirmMsg)) return;
        try {
          await api(path, { method, admin: true });
          after();
        } catch (err) { toast(err.message); }
      });
    };
    const base = `/api/practices/${encodeURIComponent(p.id)}`;
    adminAction('archive-btn', `${base}/archive`, 'POST', 'この練習をアーカイブしますか？', () => { toast('アーカイブしました'); renderDetail(p.id); });
    adminAction('unarchive-btn', `${base}/unarchive`, 'POST', null, () => { toast('予定に戻しました'); renderDetail(p.id); });
    adminAction('delete-btn', base, 'DELETE', 'この練習を削除しますか？（元に戻せません）', () => { toast('削除しました'); location.hash = p.archived ? '#/archive' : '#/'; });
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
        ? await api(`/api/practices/${encodeURIComponent(editingId)}`, { method: 'PUT', body, admin: true })
        : await api('/api/practices', { method: 'POST', body, admin: true });
      dialog.close();
      if (practice.archived) toast('終了日時を過ぎているため、アーカイブに保存しました');
      else toast('保存しました');
      const target = `#/p/${encodeURIComponent(practice.id)}`;
      if (location.hash === target) route(); else location.hash = target;
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
    .finally(route);
})();
