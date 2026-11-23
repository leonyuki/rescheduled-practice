'use strict';

const fs = require('fs');
const path = require('path');
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

class Store {
  constructor(file) {
    this.file = file;
    this.data = { practices: [] };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.practices)) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  /**
   * 終了日時を過ぎた練習を自動でアーカイブする。
   * アーカイブした件数を返す。
   */
  archivePast(now = nowLocalString()) {
    let count = 0;
    const archivedAt = new Date().toISOString();
    for (const p of this.data.practices) {
      if (!p.archived && !p.keepActive && isPast(p, now)) {
        p.archived = true;
        p.archivedAt = archivedAt;
        p.autoArchived = true;
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  list({ archived }) {
    const items = this.data.practices.filter((p) => !!p.archived === archived);
    items.sort((a, b) => {
      const ka = `${a.date}T${a.startTime || '00:00'}`;
      const kb = `${b.date}T${b.startTime || '00:00'}`;
      // 予定は近い順、アーカイブは新しい順
      return archived ? kb.localeCompare(ka) : ka.localeCompare(kb);
    });
    return items;
  }

  get(id) {
    return this.data.practices.find((p) => p.id === id) || null;
  }

  create(input) {
    const now = new Date().toISOString();
    const p = {
      id: crypto.randomUUID(),
      ...input,
      responses: [],
      archived: false,
      archivedAt: null,
      autoArchived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.data.practices.push(p);
    this.save();
    return p;
  }

  update(id, input) {
    const p = this.get(id);
    if (!p) return null;
    // 日時を編集したら自動アーカイブの対象に戻す
    Object.assign(p, input, { keepActive: false, updatedAt: new Date().toISOString() });
    this.save();
    return p;
  }

  remove(id) {
    const i = this.data.practices.findIndex((p) => p.id === id);
    if (i < 0) return false;
    this.data.practices.splice(i, 1);
    this.save();
    return true;
  }

  setArchived(id, archived) {
    const p = this.get(id);
    if (!p) return null;
    p.archived = archived;
    p.archivedAt = archived ? new Date().toISOString() : null;
    p.autoArchived = false;
    // 手動で予定に戻した練習は、編集されるまで自動アーカイブしない
    p.keepActive = !archived;
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
  }

  /** 同じ名前の回答は上書き（大文字小文字・前後空白は無視） */
  respond(id, input) {
    const p = this.get(id);
    if (!p) return null;
    const key = input.name.toLowerCase();
    const now = new Date().toISOString();
    const existing = p.responses.find((r) => r.name.toLowerCase() === key);
    if (existing) {
      Object.assign(existing, input, { updatedAt: now });
    } else {
      p.responses.push({ id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now });
    }
    p.updatedAt = now;
    this.save();
    return p;
  }

  removeResponse(id, responseId) {
    const p = this.get(id);
    if (!p) return null;
    const i = p.responses.findIndex((r) => r.id === responseId);
    if (i < 0) return null;
    p.responses.splice(i, 1);
    p.updatedAt = new Date().toISOString();
    this.save();
    return p;
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
