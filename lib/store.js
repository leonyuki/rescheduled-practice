'use strict';

const crypto = require('crypto');

const STATUSES = ['yes', 'maybe', 'no'];
const TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Tokyo';

/** 指定タイムゾーンでの現在日時を "YYYY-MM-DDTHH:MM" 形式で返す */
function nowLocalString(date = new Date(), timeZone = TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** 練習の終了日時（終了時刻が無ければ開始時刻、どちらも無ければその日の終わり） */
function practiceEndString(p) {
  const time = p.endTime || p.startTime || '23:59';
  return `${p.date}T${time}`;
}

function isPast(p, now = nowLocalString()) {
  return practiceEndString(p) <= now;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function str(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).trim().slice(0, max);
}

function validatePractice(input) {
  const errors = [];
  const p = {
    title: str(input.title, 100),
    date: str(input.date, 10),
    startTime: str(input.startTime, 5),
    endTime: str(input.endTime, 5),
    location: str(input.location, 200),
    note: str(input.note, 2000),
  };
  if (!p.title) errors.push('タイトルを入力してください');
  if (!DATE_RE.test(p.date) || Number.isNaN(Date.parse(p.date))) errors.push('日付が正しくありません');
  if (p.startTime && !TIME_RE.test(p.startTime)) errors.push('開始時刻が正しくありません');
  if (p.endTime && !TIME_RE.test(p.endTime)) errors.push('終了時刻が正しくありません');
  if (p.startTime && p.endTime && p.endTime <= p.startTime) errors.push('終了時刻は開始時刻より後にしてください');
  return { value: p, errors };
}

function validateResponse(input) {
  const errors = [];
  const r = {
    name: str(input.name, 50),
    status: str(input.status, 10),
    comment: str(input.comment, 300),
  };
  if (!r.name) errors.push('名前を入力してください');
  if (!STATUSES.includes(r.status)) errors.push('出欠の選択が正しくありません');
  return { value: r, errors };
}

const responseKey = (name) => name.trim().toLowerCase();

class Store {
  /** @param backend FileBackend | RedisBackend（lib/backends.js） */
  constructor(backend) {
    this.backend = backend;
  }

  async _withResponses(practices) {
    const map = await this.backend.listResponses(practices.map((p) => p.id));
    return practices.map((p) => ({
      ...p,
      responses: (map[p.id] || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
  }

  /**
   * 終了日時を過ぎた練習を自動でアーカイブする。
   * アーカイブした件数を返す。
   */
  async archivePast(now = nowLocalString()) {
    const archivedAt = new Date().toISOString();
    const targets = (await this.backend.listPractices()).filter(
      (p) => !p.archived && !p.keepActive && isPast(p, now)
    );
    for (const p of targets) Object.assign(p, { archived: true, archivedAt, autoArchived: true });
    await this.backend.putPractices(targets);
    return targets.length;
  }

  async list({ archived }) {
    const items = (await this.backend.listPractices()).filter((p) => !!p.archived === archived);
    items.sort((a, b) => {
      const ka = `${a.date}T${a.startTime || '00:00'}`;
      const kb = `${b.date}T${b.startTime || '00:00'}`;
      // 予定は近い順、アーカイブは新しい順
      return archived ? kb.localeCompare(ka) : ka.localeCompare(kb);
    });
    return this._withResponses(items);
  }

  async get(id) {
    const p = await this.backend.getPractice(id);
    return p ? (await this._withResponses([p]))[0] : null;
  }

  async create(input) {
    const now = new Date().toISOString();
    const p = {
      id: crypto.randomUUID(),
      ...input,
      archived: false,
      archivedAt: null,
      autoArchived: false,
      keepActive: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.putPractices([p]);
    return this.get(p.id);
  }

  async update(id, input) {
    const p = await this.backend.getPractice(id);
    if (!p) return null;
    // 日時を編集したら自動アーカイブの対象に戻す
    Object.assign(p, input, { keepActive: false, updatedAt: new Date().toISOString() });
    await this.backend.putPractices([p]);
    return this.get(id);
  }

  async remove(id) {
    if (!(await this.backend.getPractice(id))) return false;
    await this.backend.deletePractice(id);
    return true;
  }

  async setArchived(id, archived) {
    const p = await this.backend.getPractice(id);
    if (!p) return null;
    Object.assign(p, {
      archived,
      archivedAt: archived ? new Date().toISOString() : null,
      autoArchived: false,
      // 手動で予定に戻した練習は、編集されるまで自動アーカイブしない
      keepActive: !archived,
      updatedAt: new Date().toISOString(),
    });
    await this.backend.putPractices([p]);
    return this.get(id);
  }

  /** 同じ名前の回答は上書き（大文字小文字・前後空白は無視） */
  async respond(id, input) {
    if (!(await this.backend.getPractice(id))) return null;
    const key = responseKey(input.name);
    const now = new Date().toISOString();
    const existing = await this.backend.getResponse(id, key);
    const r = existing
      ? { ...existing, ...input, updatedAt: now }
      : { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
    await this.backend.putResponse(id, key, r);
    return this.get(id);
  }

  async removeResponse(id, responseId) {
    const p = await this.get(id);
    if (!p) return null;
    const r = p.responses.find((x) => x.id === responseId);
    if (!r) return null;
    await this.backend.deleteResponse(id, responseKey(r.name));
    return this.get(id);
  }
}

module.exports = {
  Store,
  STATUSES,
  nowLocalString,
  practiceEndString,
  isPast,
  validatePractice,
  validateResponse,
};
