'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 保存先の抽象化。
 *  - FileBackend:  ローカル実行用（JSON ファイル）
 *  - RedisBackend: Vercel 用（Upstash Redis の REST API。追加パッケージ不要）
 *
 * 「コレクション」（例: practices, polls）に親データを、
 * 「子コレクション」（例: responses:<練習ID>, pollAnswers:<日程調整ID>）に人ごとの回答を保存する。
 * 回答を親ごと・人ごとに分けて保存するので、同時に回答しても上書きし合わない。
 *
 * Redis のキー:
 *   <prefix>practices                 : { [practiceId]: practice }
 *   <prefix>responses:<practiceId>    : { [名前キー]: response }
 *   <prefix>polls                     : { [pollId]: poll }
 *   <prefix>pollAnswers:<pollId>      : { [名前キー]: answer }
 */

/** 汎用メソッドの上に、練習用・日程調整用の名前付きメソッドを生やす */
class BaseBackend {
  // 練習
  listPractices() { return this.listItems('practices'); }
  getPractice(id) { return this.getItem('practices', id); }
  putPractices(list) { return this.putItems('practices', list); }
  deletePractice(id) { return this.deleteItem('practices', id, 'responses'); }
  listResponses(ids) { return this.listChildren('responses', ids); }
  getResponse(id, key) { return this.getChild('responses', id, key); }
  putResponse(id, key, r) { return this.putChild('responses', id, key, r); }
  deleteResponse(id, key) { return this.deleteChild('responses', id, key); }

  // 日程調整
  listPolls() { return this.listItems('polls'); }
  getPoll(id) { return this.getItem('polls', id); }
  putPolls(list) { return this.putItems('polls', list); }
  deletePoll(id) { return this.deleteItem('polls', id, 'pollAnswers'); }
  listPollAnswers(ids) { return this.listChildren('pollAnswers', ids); }
  getPollAnswer(id, key) { return this.getChild('pollAnswers', id, key); }
  putPollAnswer(id, key, a) { return this.putChild('pollAnswers', id, key, a); }
  deletePollAnswer(id, key) { return this.deleteChild('pollAnswers', id, key); }
}

class FileBackend extends BaseBackend {
  constructor(file) {
    super();
    this.file = file;
    this.data = {};
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

  _coll(name) {
    return (this.data[name] ||= {});
  }

  async listItems(coll) {
    return Object.values(this._coll(coll)).map((x) => structuredClone(x));
  }

  async getItem(coll, id) {
    const x = this._coll(coll)[id];
    return x ? structuredClone(x) : null;
  }

  async putItems(coll, list) {
    if (!list.length) return;
    for (const x of list) this._coll(coll)[x.id] = structuredClone(x);
    this._save();
  }

  async deleteItem(coll, id, childColl) {
    delete this._coll(coll)[id];
    if (childColl) delete this._coll(childColl)[id];
    this._save();
  }

  async listChildren(childColl, ids) {
    const c = this._coll(childColl);
    const out = {};
    for (const id of ids) out[id] = Object.values(c[id] || {}).map((x) => structuredClone(x));
    return out;
  }

  async getChild(childColl, id, key) {
    const x = (this._coll(childColl)[id] || {})[key];
    return x ? structuredClone(x) : null;
  }

  async putChild(childColl, id, key, value) {
    (this._coll(childColl)[id] ||= {})[key] = structuredClone(value);
    this._save();
  }

  async deleteChild(childColl, id, key) {
    const c = this._coll(childColl);
    if (c[id]) delete c[id][key];
    this._save();
  }
}

class RedisBackend extends BaseBackend {
  constructor(url, token, prefix = 'practice-app:') {
    super();
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

  async listItems(coll) {
    return RedisBackend._hashValues(await this._cmd('HGETALL', this._k(coll)));
  }

  async getItem(coll, id) {
    const v = await this._cmd('HGET', this._k(coll), id);
    return v ? JSON.parse(v) : null;
  }

  async putItems(coll, list) {
    if (!list.length) return;
    const args = ['HSET', this._k(coll)];
    for (const x of list) args.push(x.id, JSON.stringify(x));
    await this._cmd(...args);
  }

  async deleteItem(coll, id, childColl) {
    const cmds = [['HDEL', this._k(coll), id]];
    if (childColl) cmds.push(['DEL', this._k(`${childColl}:${id}`)]);
    await this._pipeline(cmds);
  }

  async listChildren(childColl, ids) {
    const results = await this._pipeline(ids.map((id) => ['HGETALL', this._k(`${childColl}:${id}`)]));
    const out = {};
    ids.forEach((id, i) => { out[id] = RedisBackend._hashValues(results[i]); });
    return out;
  }

  async getChild(childColl, id, key) {
    const v = await this._cmd('HGET', this._k(`${childColl}:${id}`), key);
    return v ? JSON.parse(v) : null;
  }

  async putChild(childColl, id, key, value) {
    await this._cmd('HSET', this._k(`${childColl}:${id}`), key, JSON.stringify(value));
  }

  async deleteChild(childColl, id, key) {
    await this._cmd('HDEL', this._k(`${childColl}:${id}`), key);
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
