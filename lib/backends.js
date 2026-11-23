'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 保存先の抽象化。
 *  - FileBackend:  ローカル実行用（JSON ファイル）
 *  - RedisBackend: Vercel 用（Upstash Redis の REST API。追加パッケージ不要）
 *
 * データ構造:
 *  practices            : { [practiceId]: practice }
 *  responses:<practiceId>: { [名前を小文字化したキー]: response }
 * 回答を練習ごと・人ごとに分けて保存するので、同時に回答しても上書きし合いません。
 */

class FileBackend {
  constructor(file) {
    this.file = file;
    this.data = { practices: {}, responses: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && parsed.practices && !Array.isArray(parsed.practices)) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  async listPractices() {
    return Object.values(this.data.practices).map((p) => ({ ...p }));
  }

  async getPractice(id) {
    const p = this.data.practices[id];
    return p ? { ...p } : null;
  }

  async putPractices(list) {
    for (const p of list) this.data.practices[p.id] = { ...p };
    this._save();
  }

  async deletePractice(id) {
    delete this.data.practices[id];
    delete this.data.responses[id];
    this._save();
  }

  async listResponses(ids) {
    const out = {};
    for (const id of ids) out[id] = Object.values(this.data.responses[id] || {}).map((r) => ({ ...r }));
    return out;
  }

  async getResponse(id, key) {
    const r = (this.data.responses[id] || {})[key];
    return r ? { ...r } : null;
  }

  async putResponse(id, key, r) {
    (this.data.responses[id] ||= {})[key] = { ...r };
    this._save();
  }

  async deleteResponse(id, key) {
    if (this.data.responses[id]) delete this.data.responses[id][key];
    this._save();
  }
}

class RedisBackend {
  constructor(url, token, prefix = 'practice-app:') {
    this.url = url.replace(/\/+$/, '');
    this.token = token;
    this.prefix = prefix;
  }

  _k(name) {
    return this.prefix + name;
  }

  async _pipeline(commands) {
    if (!commands.length) return [];
    const res = await fetch(`${this.url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
    });
    if (!res.ok) throw new Error(`Redis error: HTTP ${res.status} ${await res.text()}`);
    const results = await res.json();
    return results.map((r) => {
      if (r.error) throw new Error(`Redis error: ${r.error}`);
      return r.result;
    });
  }

  async _cmd(...command) {
    return (await this._pipeline([command]))[0];
  }

  static _hashValues(flat) {
    const out = [];
    for (let i = 1; i < (flat || []).length; i += 2) out.push(JSON.parse(flat[i]));
    return out;
  }

  async listPractices() {
    return RedisBackend._hashValues(await this._cmd('HGETALL', this._k('practices')));
  }

  async getPractice(id) {
    const v = await this._cmd('HGET', this._k('practices'), id);
    return v ? JSON.parse(v) : null;
  }

  async putPractices(list) {
    if (!list.length) return;
    const args = ['HSET', this._k('practices')];
    for (const p of list) args.push(p.id, JSON.stringify(p));
    await this._cmd(...args);
  }

  async deletePractice(id) {
    await this._pipeline([
      ['HDEL', this._k('practices'), id],
      ['DEL', this._k(`responses:${id}`)],
    ]);
  }

  async listResponses(ids) {
    const results = await this._pipeline(ids.map((id) => ['HGETALL', this._k(`responses:${id}`)]));
    const out = {};
    ids.forEach((id, i) => { out[id] = RedisBackend._hashValues(results[i]); });
    return out;
  }

  async getResponse(id, key) {
    const v = await this._cmd('HGET', this._k(`responses:${id}`), key);
    return v ? JSON.parse(v) : null;
  }

  async putResponse(id, key, r) {
    await this._cmd('HSET', this._k(`responses:${id}`), key, JSON.stringify(r));
  }

  async deleteResponse(id, key) {
    await this._cmd('HDEL', this._k(`responses:${id}`), key);
  }
}

/** 環境変数から保存先を選ぶ（Upstash の変数があれば Redis、無ければファイル） */
function backendFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) return new RedisBackend(url, token, env.REDIS_KEY_PREFIX);
  if (env.VERCEL) {
    throw new Error(
      'Vercel 上ではデータベースが必要です。Vercel の Storage から Upstash Redis を追加してください（README 参照）'
    );
  }
  return new FileBackend(env.DATA_FILE || path.join(__dirname, '..', 'data', 'practices.json'));
}

module.exports = { FileBackend, RedisBackend, backendFromEnv };
