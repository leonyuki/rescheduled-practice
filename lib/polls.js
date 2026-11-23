'use strict';

const crypto = require('crypto');
const { STATUSES, nowLocalString, isPast, responseKey, str, DATE_RE, TIME_RE } = require('./store');

const MAX_CANDIDATES = 30;

/**
 * 日程調整
 *  poll   : { id, title, location, note, candidates: [{ id, date, startTime, endTime }],
 *             status: 'open' | 'closed' | 'decided', autoClosed, decidedCandidateId, practiceId, ... }
 *  answer : { id, name, answers: { [candidateId]: 'yes' | 'maybe' | 'no' }, comment }
 */

function validatePoll(input, existing = null) {
  const errors = [];
  const v = {
    title: str(input.title, 100),
    location: str(input.location, 200),
    note: str(input.note, 2000),
    candidates: [],
  };
  if (!v.title) errors.push('タイトルを入力してください');

  const raw = Array.isArray(input.candidates) ? input.candidates : [];
  const known = new Set((existing?.candidates || []).map((c) => c.id));
  const seen = new Set();
  raw.forEach((c, i) => {
    const cand = {
      id: known.has(c?.id) ? c.id : crypto.randomUUID(),
      date: str(c?.date, 10),
      startTime: str(c?.startTime, 5),
      endTime: str(c?.endTime, 5),
    };
    const n = `候補${i + 1}`;
    if (!DATE_RE.test(cand.date) || Number.isNaN(Date.parse(cand.date))) errors.push(`${n}: 日付が正しくありません`);
    if (cand.startTime && !TIME_RE.test(cand.startTime)) errors.push(`${n}: 開始時刻が正しくありません`);
    if (cand.endTime && !TIME_RE.test(cand.endTime)) errors.push(`${n}: 終了時刻が正しくありません`);
    if (cand.startTime && cand.endTime && cand.endTime <= cand.startTime) errors.push(`${n}: 終了時刻は開始時刻より後にしてください`);
    const dup = `${cand.date}T${cand.startTime}-${cand.endTime}`;
    if (seen.has(dup)) errors.push(`${n}: 同じ日時の候補が重複しています`);
    seen.add(dup);
    v.candidates.push(cand);
  });
  if (!v.candidates.length) errors.push('候補日を1つ以上追加してください');
  if (v.candidates.length > MAX_CANDIDATES) errors.push(`候補日は${MAX_CANDIDATES}個までです`);
  v.candidates.sort((a, b) => `${a.date}T${a.startTime}`.localeCompare(`${b.date}T${b.startTime}`));
  return { value: v, errors };
}

function validatePollAnswer(input, poll) {
  const errors = [];
  const v = { name: str(input.name, 50), comment: str(input.comment, 300), answers: {} };
  if (!v.name) errors.push('名前を入力してください');
  const given = input.answers && typeof input.answers === 'object' ? input.answers : {};
  for (const c of poll.candidates) {
    const s = str(given[c.id], 10);
    if (!STATUSES.includes(s)) {
      errors.push('すべての候補日に ○ / △ / × を選んでください');
      break;
    }
    v.answers[c.id] = s;
  }
  return { value: v, errors };
}

/** 候補ごとの集計。score は ○=2, △=1 */
function tally(poll) {
  return poll.candidates.map((c) => {
    const t = { candidateId: c.id, yes: 0, maybe: 0, no: 0 };
    for (const a of poll.answers || []) {
      const s = a.answers[c.id];
      if (s) t[s]++;
    }
    t.score = t.yes * 2 + t.maybe;
    return t;
  });
}

class PollStore {
  constructor(backend, practiceStore) {
    this.backend = backend;
    this.practices = practiceStore;
  }

  async _withAnswers(polls) {
    const map = await this.backend.listPollAnswers(polls.map((p) => p.id));
    return polls.map((p) => ({
      ...p,
      answers: (map[p.id] || []).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
  }

  /** すべての候補日が過ぎた受付中の日程調整を自動で締め切る */
  async closePast(now = nowLocalString()) {
    const targets = (await this.backend.listPolls()).filter(
      (p) => p.status === 'open' && !p.keepOpen && p.candidates.every((c) => isPast(c, now))
    );
    const at = new Date().toISOString();
    for (const p of targets) Object.assign(p, { status: 'closed', autoClosed: true, closedAt: at, updatedAt: at });
    await this.backend.putPolls(targets);
    return targets.length;
  }

  async list() {
    const polls = await this.backend.listPolls();
    const first = (p) => `${p.candidates[0]?.date || ''}T${p.candidates[0]?.startTime || ''}`;
    // 受付中を先に、その中は候補日が近い順。締切済みは新しい順
    polls.sort((a, b) => {
      const oa = a.status === 'open' ? 0 : 1;
      const ob = b.status === 'open' ? 0 : 1;
      if (oa !== ob) return oa - ob;
      return oa === 0 ? first(a).localeCompare(first(b)) : b.createdAt.localeCompare(a.createdAt);
    });
    return this._withAnswers(polls);
  }

  async get(id) {
    const p = await this.backend.getPoll(id);
    return p ? (await this._withAnswers([p]))[0] : null;
  }

  async create(input) {
    const now = new Date().toISOString();
    const p = {
      id: crypto.randomUUID(),
      ...input,
      status: 'open',
      autoClosed: false,
      keepOpen: false,
      decidedCandidateId: null,
      practiceId: null,
      createdAt: now,
      updatedAt: now,
    };
    await this.backend.putPolls([p]);
    return this.get(p.id);
  }

  async update(id, input) {
    const p = await this.backend.getPoll(id);
    if (!p) return null;
    Object.assign(p, input, { keepOpen: false, updatedAt: new Date().toISOString() });
    await this.backend.putPolls([p]);
    return this.get(id);
  }

  async remove(id) {
    if (!(await this.backend.getPoll(id))) return false;
    await this.backend.deletePoll(id);
    return true;
  }

  async setOpen(id, open) {
    const p = await this.backend.getPoll(id);
    if (!p) return null;
    const now = new Date().toISOString();
    Object.assign(p, {
      status: open ? 'open' : 'closed',
      autoClosed: false,
      // 手動で再開した日程調整は、編集されるまで自動で締め切らない
      keepOpen: open,
      closedAt: open ? null : now,
      decidedCandidateId: open ? null : p.decidedCandidateId,
      updatedAt: now,
    });
    await this.backend.putPolls([p]);
    return this.get(id);
  }

  async answer(id, input) {
    if (!(await this.backend.getPoll(id))) return null;
    const key = responseKey(input.name);
    const now = new Date().toISOString();
    const existing = await this.backend.getPollAnswer(id, key);
    const a = existing
      ? { ...existing, ...input, updatedAt: now }
      : { id: crypto.randomUUID(), ...input, createdAt: now, updatedAt: now };
    await this.backend.putPollAnswer(id, key, a);
    return this.get(id);
  }

  async removeAnswer(id, answerId) {
    const p = await this.get(id);
    if (!p) return null;
    const a = p.answers.find((x) => x.id === answerId);
    if (!a) return null;
    await this.backend.deletePollAnswer(id, responseKey(a.name));
    return this.get(id);
  }

  /**
   * 候補日を決定して練習を作成する。
   * その候補日への ○/△/× を練習の 参加/未定/不参加 として引き継ぐ。
   */
  async decide(id, candidateId) {
    const poll = await this.get(id);
    if (!poll) return null;
    const cand = poll.candidates.find((c) => c.id === candidateId);
    if (!cand) throw Object.assign(new Error('候補日が見つかりません'), { status: 400 });
    if (poll.status === 'decided') throw Object.assign(new Error('すでに日程が決定しています'), { status: 409 });

    const practice = await this.practices.create({
      title: poll.title,
      date: cand.date,
      startTime: cand.startTime,
      endTime: cand.endTime,
      location: poll.location,
      note: poll.note,
    });
    for (const a of poll.answers) {
      const status = a.answers[cand.id];
      if (status) await this.practices.respond(practice.id, { name: a.name, status, comment: a.comment || '' });
    }

    const p = await this.backend.getPoll(id);
    const now = new Date().toISOString();
    Object.assign(p, {
      status: 'decided',
      autoClosed: false,
      decidedCandidateId: cand.id,
      practiceId: practice.id,
      closedAt: now,
      updatedAt: now,
    });
    await this.backend.putPolls([p]);
    return { poll: await this.get(id), practice: await this.practices.get(practice.id) };
  }
}

module.exports = { PollStore, validatePoll, validatePollAnswer, tally };
