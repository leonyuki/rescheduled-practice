'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Store, nowLocalString, isPast, validatePractice } = require('../lib/store');
const { FileBackend, RedisBackend } = require('../lib/backends');
const { createApp } = require('../server');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-'));
  return path.join(dir, 'data.json');
}

test('nowLocalString は Asia/Tokyo の日時を返す', () => {
  // 2026-01-01T15:30Z = 2026-01-02 00:30 JST
  assert.strictEqual(nowLocalString(new Date('2026-01-01T15:30:00Z'), 'Asia/Tokyo'), '2026-01-02T00:30');
});

test('isPast は終了時刻 → 開始時刻 → 23:59 の順で判定する', () => {
  const now = '2026-05-10T18:00';
  assert.strictEqual(isPast({ date: '2026-05-10', startTime: '15:00', endTime: '17:00' }, now), true);
  assert.strictEqual(isPast({ date: '2026-05-10', startTime: '15:00', endTime: '19:00' }, now), false);
  assert.strictEqual(isPast({ date: '2026-05-10', startTime: '17:59', endTime: '' }, now), true);
  assert.strictEqual(isPast({ date: '2026-05-10', startTime: '', endTime: '' }, now), false);
  assert.strictEqual(isPast({ date: '2026-05-09', startTime: '', endTime: '' }, now), true);
});

test('validatePractice は不正な入力を弾く', () => {
  assert.ok(validatePractice({ title: '', date: '2026-01-01' }).errors.length);
  assert.ok(validatePractice({ title: 'a', date: '2026/01/01' }).errors.length);
  assert.ok(validatePractice({ title: 'a', date: '2026-01-01', startTime: '18:00', endTime: '17:00' }).errors.length);
  assert.deepStrictEqual(validatePractice({ title: 'a', date: '2026-01-01', startTime: '17:00', endTime: '18:00' }).errors, []);
});

/** Upstash Redis REST API の最小限の偽物（HGETALL/HGET/HSET/HDEL/DEL） */
async function fakeUpstash(token = 'secret') {
  const db = new Map();
  const run = ([cmd, key, ...args]) => {
    const h = db.get(key) || new Map();
    switch (cmd.toUpperCase()) {
      case 'HGETALL': return [...h].flat();
      case 'HGET': return h.get(args[0]) ?? null;
      case 'HSET': {
        let n = 0;
        for (let i = 0; i < args.length; i += 2) { if (!h.has(args[i])) n++; h.set(args[i], String(args[i + 1])); }
        db.set(key, h);
        return n;
      }
      case 'HDEL': return args.reduce((n, f) => n + (h.delete(f) ? 1 : 0), 0);
      case 'DEL': return db.delete(key) ? 1 : 0;
      default: throw new Error('unsupported ' + cmd);
    }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('unauthorized'); }
      const cmds = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(cmds.map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } })));
    });
  });
  await new Promise((r) => server.listen(0, r));
  return { server, url: `http://127.0.0.1:${server.address().port}`, token };
}

const fileStore = (file = tmpFile()) => new Store(new FileBackend(file));

test('archivePast は過去の練習だけを自動アーカイブし永続化する', async () => {
  const file = tmpFile();
  const store = fileStore(file);
  const past = await store.create({ title: '過去', date: '2026-05-01', startTime: '10:00', endTime: '12:00', location: '', note: '' });
  const future = await store.create({ title: '未来', date: '2026-05-20', startTime: '10:00', endTime: '12:00', location: '', note: '' });

  assert.strictEqual(await store.archivePast('2026-05-10T00:00'), 1);
  assert.strictEqual((await store.get(past.id)).archived, true);
  assert.strictEqual((await store.get(past.id)).autoArchived, true);
  assert.strictEqual((await store.get(future.id)).archived, false);
  assert.strictEqual(await store.archivePast('2026-05-10T00:00'), 0, '二重にアーカイブしない');

  const reloaded = fileStore(file);
  assert.deepStrictEqual((await reloaded.list({ archived: true })).map((p) => p.id), [past.id]);
  assert.deepStrictEqual((await reloaded.list({ archived: false })).map((p) => p.id), [future.id]);
});

test('respond は同じ名前の回答を上書きする', async () => {
  const store = fileStore();
  const p = await store.create({ title: 't', date: '2099-01-01', startTime: '', endTime: '', location: '', note: '' });
  await store.respond(p.id, { name: 'Taro', status: 'yes', comment: '' });
  await store.respond(p.id, { name: 'taro', status: 'no', comment: '風邪' });
  await store.respond(p.id, { name: 'Hanako', status: 'maybe', comment: '' });
  const got = await store.get(p.id);
  assert.strictEqual(got.responses.length, 2);
  assert.strictEqual(got.responses[0].status, 'no');
  assert.strictEqual(got.responses[0].comment, '風邪');
});

async function httpScenario(store) {
  const server = http.createServer(createApp(store));
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body && JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  try {
    const future = await call('POST', '/api/practices', { title: '次の練習', date: '2099-12-31', startTime: '18:00', endTime: '20:00' });
    assert.strictEqual(future.status, 201);
    assert.strictEqual(future.body.practice.archived, false);

    const r = await call('POST', `/api/practices/${future.body.practice.id}/responses`, { name: '山田', status: 'yes' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.practice.responses.length, 1);

    const bad = await call('POST', `/api/practices/${future.body.practice.id}/responses`, { name: '山田', status: 'xxx' });
    assert.strictEqual(bad.status, 400);

    const past = await call('POST', '/api/practices', { title: '昔の練習', date: '2000-01-01', startTime: '18:00', endTime: '20:00' });
    assert.strictEqual(past.status, 201);
    assert.strictEqual(past.body.practice.archived, true);

    const upcoming = await call('GET', '/api/practices?archived=false');
    assert.deepStrictEqual(upcoming.body.practices.map((p) => p.title), ['次の練習']);
    const archive = await call('GET', '/api/practices?archived=true');
    assert.deepStrictEqual(archive.body.practices.map((p) => p.title), ['昔の練習']);

    const closed = await call('POST', `/api/practices/${past.body.practice.id}/responses`, { name: '山田', status: 'yes' });
    assert.strictEqual(closed.status, 409);

    const un = await call('POST', `/api/practices/${past.body.practice.id}/unarchive`);
    assert.strictEqual(un.status, 200);
    assert.strictEqual(un.body.practice.archived, false);
    const stillActive = await call('GET', `/api/practices/${past.body.practice.id}`);
    assert.strictEqual(stillActive.body.practice.archived, false, '手動で戻した練習は再アーカイブされない');

    const del = await call('DELETE', `/api/practices/${future.body.practice.id}`);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await call('GET', `/api/practices/${future.body.practice.id}`)).status, 404);
  } finally {
    server.close();
  }
}

test('HTTP API（ファイル保存）: 作成・回答・自動アーカイブ・アーカイブ後は回答不可', async () => {
  await httpScenario(fileStore());
});

test('HTTP API（Upstash Redis 保存）: 同じシナリオが動く', async () => {
  const up = await fakeUpstash();
  try {
    await httpScenario(new Store(new RedisBackend(up.url, up.token)));
  } finally {
    up.server.close();
  }
});

test('Vercel のように req.body が解析済みでも動く', async () => {
  const { createApp } = require('../server');
  const handler = createApp(fileStore(), { serveFiles: false });
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { req.body = raw ? JSON.parse(raw) : undefined; handler(req, res); });
  });
  await new Promise((r) => server.listen(0, r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/practices`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'x', date: '2099-01-01' }),
    });
    assert.strictEqual(res.status, 201);
  } finally {
    server.close();
  }
});
