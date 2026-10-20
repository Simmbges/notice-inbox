import { createHash, randomUUID } from 'node:crypto';
import { InputError } from '../lib/notice-input.ts';
import { createTaskStore } from './task-store.mjs';
import { createCategoryStore } from './categories.mjs';
import '../public/event-rules.js';

const rules = globalThis.ZhihuiEventRules;
const timeZone = 'Asia/Shanghai';
const editable = ['title', 'date', 'time', 'endDate', 'endTime', 'kind', 'evidence', 'location', 'notes', 'sourceName', 'sourceText', 'sourceUrl', 'noticeId', 'recurrence', 'active', 'category', 'favorite', 'recordType', 'participation'];
function normalize(input) {
  try { return rules.normalizeEvent(input); }
  catch (error) { throw new InputError(error.message); }
}
function fingerprint(event) {
  const keys = ['title', 'date', 'time', 'endDate', 'endTime', 'kind', 'location', 'notes', 'sourceName', 'noticeId', 'recurrence'];
  const recurrence = event.recurrence && { until: event.recurrence.until, weekdays: event.recurrence.weekdays, intervalWeeks: event.recurrence.intervalWeeks, weeks: event.recurrence.weeks };
  return createHash('sha256').update(JSON.stringify(keys.map(key => key === 'recurrence' ? recurrence : event[key]))).digest('hex');
}
function checkObject(input, allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) throw new InputError('参数格式不正确，或包含不支持的字段。');
}

export function createEventStore(sqlite) {
  const taskStore = createTaskStore(sqlite);
  const categoryStore = createCategoryStore(sqlite);
  function withDefaults(owner, event) {
    const recordType = event.recordType || 'schedule';
    return { ...event, recordType, participation: event.participation || 'planned', category: event.category || categoryStore.defaultCategory(owner, recordType), favorite: event.favorite === true };
  }
  function normalizeForOwner(owner, input) {
    const event = withDefaults(owner, normalize(input));
    if (!categoryStore.list(owner).includes(event.category)) throw new InputError('这个分类不存在，请刷新分类后重试。');
    return event;
  }
  function transaction(work) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = work(); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  function list(owner) {
    return sqlite.prepare('SELECT data FROM notice_events WHERE owner_id = ? ORDER BY created_at, id').all(owner).map(row => withDefaults(owner, JSON.parse(row.data)));
  }
  function get(owner, id) {
    if (typeof id !== 'string' || !id || id.length > 160) throw new InputError('请提供有效的事件编号。');
    const row = sqlite.prepare('SELECT data FROM notice_events WHERE owner_id = ? AND id = ?').get(owner, id);
    if (!row) throw new InputError('事件不存在或不属于当前账号。', 404);
    return withDefaults(owner, JSON.parse(row.data));
  }
  function checkVersion(event, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new InputError('请提供正整数 expectedVersion，避免覆盖其他修改。');
    if (event.version !== expectedVersion) throw new InputError('事件已被修改，请刷新后重试。', 409);
  }
  function checkNotice(owner, noticeId) {
    if (noticeId && !sqlite.prepare('SELECT id FROM notices WHERE owner_id = ? AND id = ?').get(owner, noticeId)) throw new InputError('关联事件不存在或不属于当前账号。', 404);
  }
  function insert(owner, event, skipDuplicates = true, replacement = {}) {
    const hash = fingerprint(event);
    const duplicate = sqlite.prepare('SELECT data FROM notice_events WHERE owner_id = ? AND fingerprint = ?').get(owner, hash);
    if (duplicate) {
      if (skipDuplicates) return { duplicate: JSON.parse(duplicate.data) };
      throw new InputError('这个事件已经存在。', 409);
    }
    checkNotice(owner, event.noticeId);
    const saved = { ...event, ...replacement, id: event.id || randomUUID(), version: 1, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
    if (sqlite.prepare('SELECT id FROM notice_events WHERE owner_id = ? AND id = ?').get(owner, saved.id)) throw new InputError('事件编号已存在，请换用新编号。', 409);
    sqlite.prepare('INSERT INTO notice_events (owner_id, id, fingerprint, data, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner, saved.id, hash, JSON.stringify(saved), saved.version, saved.createdAt, saved.updatedAt);
    return { event: saved };
  }
  function save(owner, previous, input) {
    const event = { ...normalizeForOwner(owner, input), ...(previous.seriesId ? { seriesId: previous.seriesId, originalDate: previous.originalDate } : {}), id: previous.id, version: previous.version + 1, revision: previous.version + 1, createdAt: previous.createdAt, updatedAt: Math.max(Date.now(), previous.updatedAt + 1) };
    if (event.seriesId && event.recurrence) throw new InputError('单次调课只能修改这一次的安排，不能改成周期事件。');
    if (event.noticeId !== previous.noticeId) checkNotice(owner, event.noticeId);
    const hash = fingerprint(event);
    if (sqlite.prepare('SELECT id FROM notice_events WHERE owner_id = ? AND fingerprint = ? AND id != ?').get(owner, hash, previous.id)) throw new InputError('修改后的事件与已有事件重复。', 409);
    sqlite.prepare('UPDATE notice_events SET fingerprint = ?, data = ?, version = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND version = ?').run(hash, JSON.stringify(event), event.version, event.updatedAt, owner, previous.id, previous.version);
    return event;
  }
  function importEvents(owner, inputs) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new InputError('events 必须是 1—100 项的事件数组。');
    const events = inputs.map(input => normalizeForOwner(owner, input));
    return transaction(() => {
      const created = [], duplicates = [];
      for (const event of events) {
        const result = insert(owner, event);
        if (result.duplicate) duplicates.push({ id: result.duplicate.id, title: result.duplicate.title });
        else created.push(result.event);
      }
      return { imported: created.length, skipped: duplicates.length, created, duplicates };
    });
  }
  function update(owner, id, patch, expectedVersion) {
    checkObject(patch, editable);
    return transaction(() => {
      const event = get(owner, id);
      checkVersion(event, expectedVersion);
      if (event.seriesId && ('category' in patch && patch.category !== event.category || 'favorite' in patch && patch.favorite !== event.favorite || 'recordType' in patch && patch.recordType !== event.recordType || 'participation' in patch && patch.participation !== event.participation)) throw new InputError('单次调课的类型、分类、参与状态和收藏跟随整个系列，请修改整个系列。');
      const category = patch.recordType && patch.recordType !== event.recordType && !('category' in patch) && event.category === categoryStore.defaultCategory(owner, event.recordType) ? categoryStore.defaultCategory(owner, patch.recordType) : event.category;
      const saved = save(owner, event, { ...event, category, ...patch });
      if (!event.seriesId && ('category' in patch || 'favorite' in patch || 'recordType' in patch || 'participation' in patch)) {
        for (const child of list(owner).filter(value => value.seriesId === id)) save(owner, child, { ...child, category: saved.category, favorite: saved.favorite, recordType: saved.recordType, participation: saved.participation });
      }
      return saved;
    });
  }
  function changeOccurrence(owner, id, expectedVersion, occurrenceDate, changes) {
    if (!rules.validDate(occurrenceDate)) throw new InputError('请提供有效的 occurrenceDate。');
    if (changes !== null) checkObject(changes, ['date', 'time', 'endTime', 'location', 'title']);
    return transaction(() => {
      const event = get(owner, id);
      checkVersion(event, expectedVersion);
      if (!event.recurrence || !rules.expandEvent(event, occurrenceDate, occurrenceDate).length) throw new InputError('这个日期不是当前周期规则的有效安排。');
      const updated = save(owner, event, { ...event, recurrence: { ...event.recurrence, excludeDates: [...event.recurrence.excludeDates, occurrenceDate] } });
      const created = changes === null ? null : insert(owner, normalizeForOwner(owner, { ...event, ...changes, id: '', date: changes.date === undefined ? occurrenceDate : changes.date, endDate: '', recurrence: null }), false, { seriesId: event.id, originalDate: occurrenceDate }).event;
      return { event: updated, created };
    });
  }
  function overview(owner, now = Date.now()) {
    const records = list(owner), currentDate = new Date(now).toLocaleDateString('sv-SE', { timeZone });
    const window = occurrence => {
      const start = Date.parse(`${occurrence.date}T${occurrence.time || '00:00'}:00+08:00`);
      const endTime = occurrence.endTime || (occurrence.kind === 'deadline' ? occurrence.time : '') || '23:59:59.999';
      const end = Date.parse(`${occurrence.endDate || occurrence.date}T${endTime.length === 5 ? endTime + ':00' : endTime}+08:00`);
      return { start, end };
    };
    return records.filter(event => !event.seriesId).map(event => {
      let nextOccurrence = null, scheduleStatus = event.active ? 'ended' : 'cancelled';
      if (event.active && !event.date) return { ...event, eventType: 'once', nextOccurrence, scheduleStatus: 'undated' };
      if (event.active) {
        const candidates = [];
        for (const input of [event, ...records.filter(value => value.seriesId === event.id)]) {
          if (!input.active) continue;
          if (!input.recurrence) {
            const date = currentDate > input.date ? currentDate : input.date;
            if ((input.endDate || input.date) >= currentDate) candidates.push(...rules.expandEvent(input, date, date));
            continue;
          }
          const until = input.recurrence.until;
          for (let from = currentDate > input.date ? currentDate : input.date; from <= until;) {
            const to = rules.shiftDay(from, 365) < until ? rules.shiftDay(from, 365) : until;
            const next = rules.expandEvent(input, from, to).find(value => window(value).end > now);
            if (next) { candidates.push(next); break; }
            from = rules.shiftDay(to, 1);
          }
        }
        const pending = candidates.filter(value => window(value).end > now).sort((a, b) => window(a).start - window(b).start || a.id.localeCompare(b.id));
        if (pending.length) {
          nextOccurrence = pending[0];
          scheduleStatus = window(nextOccurrence).start <= now ? 'ongoing' : 'upcoming';
        }
      }
      return { ...event, eventType: event.recurrence ? 'recurring' : 'once', nextOccurrence, scheduleStatus };
    });
  }
  function occurrences(owner, options = {}) {
    checkObject(options, ['from', 'to', 'type', 'kind', 'recordType', 'query', 'limit', 'offset']);
    const { from = rules.today(), type = 'all', kind = 'all', recordType = 'all', query = '', limit = 100, offset = 0 } = options;
    if (!rules.validDate(from)) throw new InputError('from 必须是有效的 YYYY-MM-DD 日期。');
    const to = options.to === undefined ? rules.shiftDay(from, 6) : options.to;
    try { rules.checkRange(from, to); } catch (error) { throw new InputError(error.message); }
    if (!['all', 'once', 'recurring'].includes(type) || !['all', 'event', 'deadline'].includes(kind)) throw new InputError('请选择有效的事件类型和事项类型。');
    if (!['all', 'schedule', 'course'].includes(recordType)) throw new InputError('请选择有效的日程或课程类型。');
    if (typeof query !== 'string' || query.length > 200) throw new InputError('搜索关键词最多 200 个字符。');
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0) throw new InputError('limit 须为 1—200 的整数，offset 须为非负整数。');
    const result = [];
    const records = list(owner), parents = new Map(records.map(event => [event.id, event]));
    for (const event of records) {
      if (event.seriesId && !parents.get(event.seriesId)?.active) continue;
      if (recordType !== 'all' && event.recordType !== recordType) continue;
      for (const occurrence of rules.expandEvent(event, from, to)) result.push({ ...occurrence, id: `event:${occurrence.id}`, sourceType: 'event', occupiesTime: event.participation === 'planned' && event.kind === 'event' });
    }
    {
      const notices = sqlite.prepare('SELECT data FROM notices WHERE owner_id = ? ORDER BY id').all(owner);
      for (const row of notices) {
        const notice = JSON.parse(row.data), events = [...(notice.events || [])];
        if (notice.active === false || recordType !== 'all' && (notice.recordType || 'schedule') !== recordType) continue;
        if (notice.deadline && !events.some(event => event.kind === 'deadline' && event.date === notice.deadline)) events.push({ title: notice.title, date: notice.deadline, kind: 'deadline' });
        events.forEach((raw, index) => {
          const event = normalize({ ...raw, id: notice.id, recordType: notice.recordType || 'schedule', participation: notice.participation || 'reference', location: raw.location || notice.location || '', sourceName: notice.sourceName || '', sourceText: notice.content || '', noticeId: notice.id });
          for (const occurrence of rules.expandEvent(event, from, to)) result.push({ ...occurrence, id: `notice:${notice.id}:${index}:${occurrence.occurrenceDate}`, eventId: '', sourceType: 'notice', noticeId: notice.id, noticeTitle: notice.title, category: notice.category, sourceUrl: notice.sourceUrl || '', version: 1, revision: 1, occupiesTime: event.participation === 'planned' && event.kind === 'event' });
        });
      }
      for (const task of recordType === 'all' ? taskStore.list(owner).tasks : []) {
        if (task.status === 'cancelled') continue;
        const dates = [
          { node: 'planned', date: task.plannedDate, time: task.plannedStartTime, endTime: task.plannedEndTime, kind: 'event' },
          { node: 'due', date: task.dueDate, time: '', endTime: '', kind: 'deadline' },
        ];
        for (const { node, date, time, endTime, kind } of dates) {
          if (!date) continue;
          const event = normalize({ title: task.title, date, time, endTime, kind, notes: task.notes, noticeId: task.noticeId });
          for (const occurrence of rules.expandEvent(event, from, to)) result.push({ ...occurrence, id: `task:${task.id}:${node}:${date}`, eventId: '', taskId: task.id, taskNode: node, sourceType: 'task', status: task.status, priority: task.priority, estimatedMinutes: task.estimatedMinutes, version: task.version, revision: task.version, sourceName: '个人任务', occupiesTime: task.status !== 'done' && kind === 'event' });
        }
      }
    }
    const search = query.trim().toLocaleLowerCase();
    const filtered = result.filter(event => (type === 'all' || event.eventType === type) && (kind === 'all' || event.kind === kind) && (!search || [event.title, event.notes, event.location, event.sourceName, event.sourceText, event.evidence, event.noticeTitle].some(value => value?.toLocaleLowerCase().includes(search))));
    filtered.sort((a, b) => a.displayDate.localeCompare(b.displayDate) || Number(b.ongoing) - Number(a.ongoing) || (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title, 'zh-CN') || a.id.localeCompare(b.id));
    return { today: rules.today(), timeZone, events: filtered.slice(offset, offset + limit), total: filtered.length, hasMore: offset + limit < filtered.length, limit, offset };
  }
  return { list, overview, import: importEvents, update, occurrences, changeOccurrence };
}
