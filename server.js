'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, validatePractice, validateResponse } = require('./lib/store');
const { backendFromEnv } = require('./lib/backends');
const { PollStore, validatePoll, validatePollAnswer } = require('./lib/polls');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ARCHIVE_INTERVAL_MS = Number(process.env.ARCHIVE_INTERVAL_MS) || 60 * 1000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(json);
}

function readBody(req) {
  // Vercel では req.body に解析済みの本文が入っている
  if (req.body !== undefined) {
    const b = req.body;
    if (b === null || b === '') return Promise.resolve({});
    if (typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try {
      return Promise.resolve(JSON.parse(String(b)));
    } catch {
      return Promise.reject(Object.assign(new Error('JSONが不正です'), { status: 400 }));
    }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100 * 1024) {
        reject(Object.assign(new Error('リクエストが大きすぎます'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('JSONが不正です'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function checkAdmin(req, password) {
  if (!password) return true;
  const given = String(req.headers['x-admin-password'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA なので未知のパスは index.html を返す
      if (!path.extname(rel)) return serveStatic(req, res, '/');
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const UNAUTHORIZED = { error: '管理者パスワードが必要です' };

/** /api/polls 以下（日程調整） */
async function handlePolls(req, res, seg, polls, isAdmin) {
  const method = req.method;

  // /api/polls
  if (seg.length === 1) {
    if (method === 'GET') return sendJson(res, 200, { polls: await polls.list() });
    if (method === 'POST') {
      if (!isAdmin(req)) return sendJson(res, 401, UNAUTHORIZED);
      const { value, errors } = validatePoll(await readBody(req));
      if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
      return sendJson(res, 201, { poll: await polls.create(value) });
    }
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  const id = seg[1];
  const poll = await polls.get(id);
  if (!poll) return sendJson(res, 404, { error: '日程調整が見つかりません' });

  // /api/polls/:id
  if (seg.length === 2) {
    if (method === 'GET') return sendJson(res, 200, { poll });
    if (method === 'PUT') {
      if (!isAdmin(req)) return sendJson(res, 401, UNAUTHORIZED);
      const { value, errors } = validatePoll(await readBody(req), poll);
      if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
      if (poll.status === 'decided') {
        // 決定済みの候補日は消せない
        const kept = value.candidates.some((c) => c.id === poll.decidedCandidateId);
        if (!kept) return sendJson(res, 409, { error: '決定済みの候補日は削除できません' });
      }
      return sendJson(res, 200, { poll: await polls.update(id, value) });
    }
    if (method === 'DELETE') {
      if (!isAdmin(req)) return sendJson(res, 401, UNAUTHORIZED);
      await polls.remove(id);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  // /api/polls/:id/answers
  if (seg[2] === 'answers') {
    if (seg.length === 4 && method === 'DELETE') {
      if (!isAdmin(req)) return sendJson(res, 401, UNAUTHORIZED);
      const p = await polls.removeAnswer(id, seg[3]);
      if (!p) return sendJson(res, 404, { error: '回答が見つかりません' });
      return sendJson(res, 200, { poll: p });
    }
    if (seg.length === 3 && method === 'POST') {
      if (poll.status !== 'open') return sendJson(res, 409, { error: 'この日程調整は締め切られています' });
      const { value, errors } = validatePollAnswer(await readBody(req), poll);
      if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
      return sendJson(res, 200, { poll: await polls.answer(id, value) });
    }
    return sendJson(res, 405, { error: 'Method Not Allowed' });
  }

  // /api/polls/:id/close , /reopen , /decide
  if (seg.length === 3 && method === 'POST' && ['close', 'reopen', 'decide'].includes(seg[2])) {
    if (!isAdmin(req)) return sendJson(res, 401, UNAUTHORIZED);
    if (poll.status === 'decided') return sendJson(res, 409, { error: 'すでに日程が決定しています' });
    if (seg[2] === 'decide') {
      const body = await readBody(req);
      return sendJson(res, 200, await polls.decide(id, String(body.candidateId || '')));
    }
    return sendJson(res, 200, { poll: await polls.setOpen(id, seg[2] === 'reopen') });
  }

  return sendJson(res, 404, { error: 'Not Found' });
}

function createApp(store, { serveFiles = true, adminPassword = ADMIN_PASSWORD, polls } = {}) {
  const isAdmin = (req) => checkAdmin(req, adminPassword);
  const pollStore = polls || new PollStore(store.backend, store);
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    if (!pathname.startsWith('/api/')) {
      if (!serveFiles) return sendJson(res, 404, { error: 'Not Found' });
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      return serveStatic(req, res, pathname);
    }

    try {
      // アクセスのたびにも過去の練習をアーカイブ（タイマーとの二重化）
      await store.archivePast();
      await pollStore.closePast();

      const seg = pathname.split('/').filter(Boolean).slice(1); // ['practices', id, ...]

      if (seg[0] === 'config' && method === 'GET') {
        return sendJson(res, 200, { adminRequired: !!adminPassword });
      }

      if (seg[0] === 'admin' && seg[1] === 'check' && method === 'POST') {
        return sendJson(res, isAdmin(req) ? 200 : 401, { ok: isAdmin(req) });
      }

      if (seg[0] === 'polls') return await handlePolls(req, res, seg, pollStore, isAdmin);

      if (seg[0] !== 'practices') return sendJson(res, 404, { error: 'Not Found' });

      // /api/practices
      if (seg.length === 1) {
        if (method === 'GET') {
          const archived = url.searchParams.get('archived') === 'true';
          return sendJson(res, 200, { practices: await store.list({ archived }) });
        }
        if (method === 'POST') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          const { value, errors } = validatePractice(await readBody(req));
          if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
          const p = await store.create(value);
          await store.archivePast();
      await pollStore.closePast();
          return sendJson(res, 201, { practice: await store.get(p.id) });
        }
        return sendJson(res, 405, { error: 'Method Not Allowed' });
      }

      const id = seg[1];
      const practice = await store.get(id);
      if (!practice) return sendJson(res, 404, { error: '練習が見つかりません' });

      // /api/practices/:id
      if (seg.length === 2) {
        if (method === 'GET') return sendJson(res, 200, { practice });
        if (method === 'PUT') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          const { value, errors } = validatePractice(await readBody(req));
          if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
          await store.update(id, value);
          await store.archivePast();
      await pollStore.closePast();
          return sendJson(res, 200, { practice: await store.get(id) });
        }
        if (method === 'DELETE') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          await store.remove(id);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: 'Method Not Allowed' });
      }

      // /api/practices/:id/responses
      if (seg[2] === 'responses') {
        // 回答の削除は管理者のみ（アーカイブ済みでも可）
        if (seg.length === 4 && method === 'DELETE') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          const p = await store.removeResponse(id, seg[3]);
          if (!p) return sendJson(res, 404, { error: '回答が見つかりません' });
          return sendJson(res, 200, { practice: p });
        }
        if (practice.archived) {
          return sendJson(res, 409, { error: 'アーカイブ済みの練習には回答できません' });
        }
        if (seg.length === 3 && method === 'POST') {
          const { value, errors } = validateResponse(await readBody(req));
          if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
          return sendJson(res, 200, { practice: await store.respond(id, value) });
        }
        return sendJson(res, 405, { error: 'Method Not Allowed' });
      }

      // /api/practices/:id/archive , /unarchive（手動操作）
      if ((seg[2] === 'archive' || seg[2] === 'unarchive') && method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
        return sendJson(res, 200, { practice: await store.setArchived(id, seg[2] === 'archive') });
      }

      return sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      return sendJson(res, status, { error: status === 500 ? 'サーバーエラー' : err.message });
    }
  };
}

function start() {
  const store = new Store(backendFromEnv());
  const runArchive = async () => {
    try {
      const count = await store.archivePast();
      if (count) console.log(`${count} 件の過去の練習を自動アーカイブしました`);
    } catch (err) {
      console.error('自動アーカイブに失敗しました', err);
    }
  };
  runArchive();
  const timer = setInterval(runArchive, ARCHIVE_INTERVAL_MS);
  timer.unref();

  const server = http.createServer(createApp(store));
  server.listen(PORT, () => {
    console.log(`練習出欠調整サイト: http://localhost:${PORT}`);
    if (ADMIN_PASSWORD) console.log('管理者パスワードが有効です');
  });
  return server;
}

if (require.main === module) start();

module.exports = { createApp };
