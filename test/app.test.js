'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { Store, nowLocalString, isPast, validatePractice } = require('../lib/store');
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

test('archivePast は過去の練習だけを自動アーカイブし永続化する', () => {
  const file = tmpFile();
  const store = new Store(file);
  const past = store.create({ title: '過去', date: '2026-05-01', startTime: '10:00', endTime: '12:00', location: '', note: '' });
  const future = store.create({ title: '未来', date: '2026-05-20', startTime: '10:00', endTime: '12:00', location: '', note: '' });

  assert.strictEqual(store.archivePast('2026-05-10T00:00'), 1);
  assert.strictEqual(store.get(past.id).archived, true);
  assert.strictEqual(store.get(past.id).autoArchived, true);
  assert.strictEqual(store.get(future.id).archived, false);
  assert.strictEqual(store.archivePast('2026-05-10T00:00'), 0, '二重にアーカイブしない');

  const reloaded = new Store(file);
  assert.deepStrictEqual(reloaded.list({ archived: true }).map((p) => p.id), [past.id]);
  assert.deepStrictEqual(reloaded.list({ archived: false }).map((p) => p.id), [future.id]);
});

test('respond は同じ名前の回答を上書きする', () => {
  const store = new Store(tmpFile());
  const p = store.create({ title: 't', date: '2099-01-01', startTime: '', endTime: '', location: '', note: '' });
  store.respond(p.id, { name: 'Taro', status: 'yes', comment: '' });
  store.respond(p.id, { name: 'taro', status: 'no', comment: '風邪' });
  store.respond(p.id, { name: 'Hanako', status: 'maybe', comment: '' });
  const got = store.get(p.id);
  assert.strictEqual(got.responses.length, 2);
  assert.strictEqual(got.responses[0].status, 'no');
  assert.strictEqual(got.responses[0].comment, '風邪');
});

test('HTTP API: 作成・回答・過去日付は自動アーカイブ・アーカイブ後は回答不可', async () => {
  const store = new Store(tmpFile());
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
});
