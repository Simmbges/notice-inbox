import { randomUUID } from 'node:crypto';
import { InputError } from '../lib/notice-input.ts';

const timeZone = 'Asia/Shanghai';
const statuses = ['todo', 'in_progress', 'done', 'cancelled'];
const taskFields = ['title', 'notes', 'noticeId', 'status', 'priority', 'dueDate', 'estimatedMinutes', 'plannedDate', 'plannedStartTime', 'plannedEndTime'];
const settingFields = ['timeZone', 'dailyCapacityMinutes', 'bufferMinutes', 'dayStart', 'dayEnd', 'notes', 'semesterStart', 'semesterEnd', 'classPeriods'];
const taskDefaults = { title: '', notes: '', noticeId: '', status: 'todo', priority: 'normal', dueDate: '', estimatedMinutes: 0, plannedDate: '', plannedStartTime: '', plannedEndTime: '' };
const settingDefaults = { timeZone, dailyCapacityMinutes: 120, bufferMinutes: 15, dayStart: '08:00', dayEnd: '22:00', notes: '', semesterStart: '', semesterEnd: '', classPeriods: [], version: 0 };
const dateAt = value => new Date(value).toLocaleDateString('sv-SE', { timeZone });
const context = () => ({ today: dateAt(Date.now()), timeZone });

function checkOwner(owner) {
  if (typeof owner !== 'string' || !owner || owner.length > 160) throw new InputError('请提供有效的账号。');
}

function checkObject(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new InputError('请只传入支持的字段。');
}

function text(value, field, limit, required = false) {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是文本。`);
  const result = value.trim();
  if (result.length > limit || required && !result) throw new InputError(`${field} ${required ? '需要填写，且' : ''}最多 ${limit} 个字符。`);
  return result;
}

function date(value, field, required = false) {
  if (typeof value !== 'string' || (required || value !== '') && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) throw new InputError(`${field} 必须是有效的 YYYY-MM-DD 日期；未知日期请留空。`);
  return value;
}

function time(value, field, required = false) {
  if (typeof value !== 'string' || (required || value !== '') && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new InputError(`${field} 必须是 HH:mm 时间。`);
  return value;
}

function integer(value, field, maximum) {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new InputError(`${field} 必须是 0—${maximum} 的整数。`);
  return value;
}

function checkVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new InputError('请提供当前 expectedVersion。');
}

function normalizeTask(value, previous = taskDefaults) {
  checkObject(value, taskFields);
  const next = { ...previous, ...value };
  next.title = text(next.title, 'title', 120, true);
  next.notes = text(next.notes, 'notes', 4000);
  next.noticeId = text(next.noticeId, 'noticeId', 160);
  if (!statuses.includes(next.status)) throw new InputError('status 请选择 todo、in_progress、done 或 cancelled。');
  if (!['high', 'normal', 'low'].includes(next.priority)) throw new InputError('priority 请选择 high、normal 或 low。');
  for (const field of ['dueDate', 'plannedDate']) next[field] = date(next[field], field);
  for (const field of ['plannedStartTime', 'plannedEndTime']) next[field] = time(next[field], field);
  next.estimatedMinutes = integer(next.estimatedMinutes, 'estimatedMinutes', 10080);
  if ((next.plannedStartTime || next.plannedEndTime) && !next.plannedDate) throw new InputError('填写计划时间时必须填写 plannedDate。');
  if (next.plannedEndTime && (!next.plannedStartTime || next.plannedEndTime <= next.plannedStartTime)) throw new InputError('计划结束时间需要开始时间，且必须在同一天晚于开始时间。');
  return next;
}

function normalizeSettings(value, previous) {
  checkObject(value, settingFields);
  const next = { ...previous, ...value };
  if (next.timeZone !== timeZone) throw new InputError('timeZone 目前仅支持 Asia/Shanghai。');
  next.dailyCapacityMinutes = integer(next.dailyCapacityMinutes, 'dailyCapacityMinutes', 1440);
  next.bufferMinutes = integer(next.bufferMinutes, 'bufferMinutes', 180);
  next.dayStart = time(next.dayStart, 'dayStart', true);
  next.dayEnd = time(next.dayEnd, 'dayEnd', true);
  if (next.dayEnd <= next.dayStart) throw new InputError('dayEnd 必须晚于同一天的 dayStart。');
  next.notes = text(next.notes, 'notes', 2000);
  next.semesterStart = date(next.semesterStart, 'semesterStart');
  next.semesterEnd = date(next.semesterEnd, 'semesterEnd');
  if (next.semesterStart && next.semesterEnd && next.semesterEnd < next.semesterStart) throw new InputError('semesterEnd 不能早于 semesterStart。');
  if (!Array.isArray(next.classPeriods) || next.classPeriods.length > 30) throw new InputError('classPeriods 必须是最多 30 项的节次时间数组。');
  next.classPeriods = next.classPeriods.map(value => {
    checkObject(value, ['period', 'start', 'end']);
    if (!Number.isInteger(value.period) || value.period < 1 || value.period > 30) throw new InputError('period 必须是 1—30 的整数。');
    const start = time(value.start, 'start', true), end = time(value.end, 'end', true);
    if (end <= start) throw new InputError('节次结束时间必须晚于同一天的开始时间。');
    return { period: value.period, start, end };
  }).sort((a, b) => a.period - b.period);
  if (new Set(next.classPeriods.map(value => value.period)).size !== next.classPeriods.length) throw new InputError('节次编号不能重复。');
  const byTime = [...next.classPeriods].sort((a, b) => a.start.localeCompare(b.start));
  if (byTime.some((value, index) => index > 0 && value.start < byTime[index - 1].end)) throw new InputError('不同节次的时间不能重叠。');
  return next;
}

export function createTaskStore(sqlite) {
  function transaction(action) {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const result = action(); sqlite.exec('COMMIT'); return result; }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }

  function rows(owner) {
    return sqlite.prepare('SELECT data FROM personal_tasks WHERE owner_id = ? ORDER BY updated_at DESC, id DESC').all(owner).map(row => JSON.parse(row.data));
  }

  function checkNotice(owner, noticeId) {
    if (noticeId && !sqlite.prepare('SELECT id FROM notices WHERE owner_id = ? AND id = ?').get(owner, noticeId)) throw new InputError('关联事件不存在或不属于当前账号。', 404);
  }

  function record(owner, before, after) {
    sqlite.prepare('INSERT INTO task_history (owner_id, task_id, before_data, after_data, changed_at) VALUES (?, ?, ?, ?, ?)').run(owner, after.id, before ? JSON.stringify(before) : null, JSON.stringify(after), after.updatedAt);
  }

  function list(owner, options = {}) {
    checkOwner(owner); checkObject(options, ['status', 'query']);
    const { status = 'all', query = '' } = options;
    if (status !== 'all' && !statuses.includes(status)) throw new InputError('请选择有效的任务状态。');
    const keyword = text(query, 'query', 200).toLocaleLowerCase();
    const tasks = rows(owner).filter(task => (status === 'all' || task.status === status) && (!keyword || `${task.title}\n${task.notes}`.toLocaleLowerCase().includes(keyword)));
    return { tasks, ...context() };
  }

  function create(owner, value) {
    checkOwner(owner);
    const normalized = normalizeTask(value);
    return transaction(() => {
      const duplicate = sqlite.prepare("SELECT data FROM personal_tasks WHERE owner_id = ? AND json_extract(data, '$.title') = ? AND json_extract(data, '$.noticeId') = ? AND json_extract(data, '$.status') IN ('todo', 'in_progress') ORDER BY created_at, id LIMIT 1").get(owner, normalized.title, normalized.noticeId);
      if (duplicate) return { task: JSON.parse(duplicate.data), duplicate: true };
      checkNotice(owner, normalized.noticeId);
      const now = Date.now();
      const task = { id: randomUUID(), ...normalized, completedAt: normalized.status === 'done' ? now : null, createdAt: now, updatedAt: now, version: 1 };
      sqlite.prepare('INSERT INTO personal_tasks (owner_id, id, data, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?)').run(owner, task.id, JSON.stringify(task), now, now, task.version);
      record(owner, null, task);
      return { task, duplicate: false };
    });
  }

  function update(owner, id, patch, expectedVersion) {
    checkOwner(owner); checkVersion(expectedVersion);
    id = text(id, 'id', 160, true);
    checkObject(patch, taskFields);
    return transaction(() => {
      const row = sqlite.prepare('SELECT data, version FROM personal_tasks WHERE owner_id = ? AND id = ?').get(owner, id);
      if (!row) throw new InputError('任务不存在或不属于当前账号。', 404);
      if (row.version !== expectedVersion) throw new InputError('任务已被更新，请刷新后重试。', 409);
      const before = JSON.parse(row.data);
      const task = normalizeTask(patch, before);
      if (task.noticeId !== before.noticeId) checkNotice(owner, task.noticeId);
      const now = Date.now();
      task.completedAt = task.status === 'done' ? before.status === 'done' ? before.completedAt : now : null;
      task.updatedAt = now; task.version = row.version + 1;
      sqlite.prepare('UPDATE personal_tasks SET data = ?, updated_at = ?, version = ? WHERE owner_id = ? AND id = ?').run(JSON.stringify(task), now, task.version, owner, id);
      record(owner, before, task);
      return { task };
    });
  }

  function settings(owner) {
    checkOwner(owner);
    const row = sqlite.prepare('SELECT data FROM task_settings WHERE owner_id = ?').get(owner);
    return row ? JSON.parse(row.data) : { ...settingDefaults, classPeriods: [] };
  }

  function saveSettings(owner, patch, expectedVersion) {
    checkOwner(owner); checkVersion(expectedVersion);
    return transaction(() => {
      const before = settings(owner);
      if (before.version !== expectedVersion) throw new InputError('时间偏好已被更新，请刷新后重试。', 409);
      const next = normalizeSettings(patch, before);
      next.version = before.version + 1;
      sqlite.prepare('INSERT INTO task_settings (owner_id, data, version) VALUES (?, ?, ?) ON CONFLICT(owner_id) DO UPDATE SET data = excluded.data, version = excluded.version').run(owner, JSON.stringify(next), next.version);
      return next;
    });
  }

  function review(owner, window) {
    checkOwner(owner); checkObject(window, ['from', 'to']);
    const from = date(window.from, 'from', true), to = date(window.to, 'to', true);
    const days = (Date.parse(to) - Date.parse(from)) / 86400000 + 1;
    if (days < 1 || days > 366) throw new InputError('复盘范围须按开始、结束顺序填写，且最多包含 366 天。');
    const start = Date.parse(`${from}T00:00:00+08:00`), end = Date.parse(`${to}T00:00:00+08:00`) + 86400000;
    const clock = context(), tasks = rows(owner);
    const inWindow = value => Boolean(value) && value >= from && value <= to;
    const during = value => typeof value === 'number' && value >= start && value < end;
    const completed = tasks.filter(task => task.status === 'done' && during(task.completedAt));
    const scheduled = tasks.filter(task => inWindow(task.plannedDate));
    const due = tasks.filter(task => inWindow(task.dueDate));
    const overdue = tasks.filter(task => task.dueDate && task.dueDate < clock.today && !['done', 'cancelled'].includes(task.status));
    const changed = new Set(sqlite.prepare('SELECT DISTINCT task_id FROM task_history WHERE owner_id = ? AND changed_at >= ? AND changed_at < ?').all(owner, start, end).map(row => row.task_id));
    const statusCounts = Object.fromEntries(statuses.map(status => [status, 0]));
    for (const task of tasks) {
      if (changed.has(task.id) || inWindow(task.plannedDate) || inWindow(task.dueDate) || during(task.completedAt) || during(task.createdAt) || during(task.updatedAt)) statusCounts[task.status]++;
    }
    const historyRows = sqlite.prepare('SELECT id, task_id, before_data, after_data, changed_at FROM task_history WHERE owner_id = ? AND changed_at >= ? AND changed_at < ? ORDER BY changed_at DESC, id DESC LIMIT 201').all(owner, start, end);
    const changes = historyRows.slice(0, 200).map(row => ({ id: row.id, taskId: row.task_id, changedAt: row.changed_at, before: row.before_data ? JSON.parse(row.before_data) : null, after: JSON.parse(row.after_data) }));
    return { from, to, ...clock, completed, scheduled, due, overdue, statusCounts, statusCountsScope: '窗口内创建、修改、完成、计划或到期的任务，按当前状态统计。', changes, changesTruncated: historyRows.length > 200, estimatedMinutesNote: 'estimatedMinutes 仅为预计用时，不代表实际工作量。' };
  }

  return { list, create, update, settings, saveSettings, review };
}
