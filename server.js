'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store, validatePractice, validateResponse } = require('./lib/store');

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'practices.json');
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

function isAdmin(req) {
  if (!ADMIN_PASSWORD) return true;
  const given = String(req.headers['x-admin-password'] || '');
  const a = Buffer.from(given);
  const b = Buffer.from(ADMIN_PASSWORD);
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

function createApp(store) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    if (!pathname.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      return serveStatic(req, res, pathname);
    }

    try {
      // アクセスのたびにも過去の練習をアーカイブ（タイマーとの二重化）
      store.archivePast();

      const seg = pathname.split('/').filter(Boolean).slice(1); // ['practices', id, ...]

      if (seg[0] === 'config' && method === 'GET') {
        return sendJson(res, 200, { adminRequired: !!ADMIN_PASSWORD });
      }

      if (seg[0] === 'admin' && seg[1] === 'check' && method === 'POST') {
        return sendJson(res, isAdmin(req) ? 200 : 401, { ok: isAdmin(req) });
      }

      if (seg[0] !== 'practices') return sendJson(res, 404, { error: 'Not Found' });

      // /api/practices
      if (seg.length === 1) {
        if (method === 'GET') {
          const archived = url.searchParams.get('archived') === 'true';
          return sendJson(res, 200, { practices: store.list({ archived }) });
        }
        if (method === 'POST') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          const { value, errors } = validatePractice(await readBody(req));
          if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
          const p = store.create(value);
          store.archivePast();
          return sendJson(res, 201, { practice: store.get(p.id) });
        }
        return sendJson(res, 405, { error: 'Method Not Allowed' });
      }

      const id = seg[1];
      const practice = store.get(id);
      if (!practice) return sendJson(res, 404, { error: '練習が見つかりません' });

      // /api/practices/:id
      if (seg.length === 2) {
        if (method === 'GET') return sendJson(res, 200, { practice });
        if (method === 'PUT') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          const { value, errors } = validatePractice(await readBody(req));
          if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
          store.update(id, value);
          store.archivePast();
          return sendJson(res, 200, { practice: store.get(id) });
        }
        if (method === 'DELETE') {
          if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
          store.remove(id);
          return sendJson(res, 200, { ok: true });
        }
        return sendJson(res, 405, { error: 'Method Not Allowed' });
      }

      // /api/practices/:id/responses
      if (seg[2] === 'responses') {
        if (practice.archived) {
          return sendJson(res, 409, { error: 'アーカイブ済みの練習には回答できません' });
        }
        if (seg.length === 3 && method === 'POST') {
          const { value, errors } = validateResponse(await readBody(req));
          if (errors.length) return sendJson(res, 400, { error: errors.join('\n') });
          return sendJson(res, 200, { practice: store.respond(id, value) });
        }
        if (seg.length === 4 && method === 'DELETE') {
          const p = store.removeResponse(id, seg[3]);
          if (!p) return sendJson(res, 404, { error: '回答が見つかりません' });
          return sendJson(res, 200, { practice: p });
        }
        return sendJson(res, 405, { error: 'Method Not Allowed' });
      }

      // /api/practices/:id/archive , /unarchive（手動操作）
      if ((seg[2] === 'archive' || seg[2] === 'unarchive') && method === 'POST') {
        if (!isAdmin(req)) return sendJson(res, 401, { error: '管理者パスワードが必要です' });
        return sendJson(res, 200, { practice: store.setArchived(id, seg[2] === 'archive') });
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
  const store = new Store(DATA_FILE);
  const n = store.archivePast();
  if (n) console.log(`${n} 件の過去の練習をアーカイブしました`);

  const timer = setInterval(() => {
    try {
      const count = store.archivePast();
      if (count) console.log(`${count} 件の過去の練習を自動アーカイブしました`);
    } catch (err) {
      console.error('自動アーカイブに失敗しました', err);
    }
  }, ARCHIVE_INTERVAL_MS);
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
