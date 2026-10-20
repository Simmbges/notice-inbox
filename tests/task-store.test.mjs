import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../standalone/database.mjs';
import { createTaskStore } from '../standalone/task-store.mjs';

function fixture(t) {
  const database = openDatabase(':memory:');
  for (const owner of ['alice', 'bob']) database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(owner, `${owner}@example.test`, 'fixture-only', 0);
  t.after(() => database.close());
  return { ...database, store: createTaskStore(database.sqlite) };
}

function addNotice(sqlite, owner, id) {
  sqlite.prepare('INSERT INTO notices VALUES (?, ?, ?, ?, ?, ?)').run(owner, id, `${owner}-${id}`, JSON.stringify({ id, title: '通知原文' }), 0, 0);
}

const fails = (action, status = 400) => assert.throws(action, error => error.status === status);

test('任务规范化保留明确日期与计划时间，不猜测未知日期', t => {
  const { store } = fixture(t);
  const result = store.create('alice', { title: '  做报名材料  ', notes: '  先准备扫描件  ' });
  assert.equal(result.duplicate, false);
  assert.deepEqual(result.task, {
    id: result.task.id, title: '做报名材料', notes: '先准备扫描件', noticeId: '', status: 'todo', priority: 'normal',
    dueDate: '', estimatedMinutes: 0, plannedDate: '', plannedStartTime: '', plannedEndTime: '',
    completedAt: null, createdAt: result.task.createdAt, updatedAt: result.task.createdAt, version: 1,
  });
  const planned = store.create('alice', { title: '计划工作', dueDate: '2028-02-29', plannedDate: '2028-02-28', plannedStartTime: '00:00', plannedEndTime: '23:59', estimatedMinutes: 10080, priority: 'high' }).task;
  assert.equal(planned.plannedStartTime, '00:00'); assert.equal(planned.estimatedMinutes, 10080);
  const done = store.create('alice', { title: '已经完成', status: 'done' }).task;
  assert.equal(done.completedAt, done.createdAt);
  assert.equal(store.list('alice', { query: '扫描件', status: 'todo' }).tasks[0].id, result.task.id);
  assert.equal(store.list('alice', { query: 'PLAN' }).tasks.length, 0);
  assert.match(store.list('alice').today, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(store.list('alice').timeZone, 'Asia/Shanghai');
});

test('任务拒绝非法结构、超限文本、无效日期时间与只读字段', t => {
  const { store } = fixture(t);
  for (const value of [null, [], '任务', {}, { title: '' }, { title: '   ' }, { title: 1 }, { title: '甲'.repeat(121) }]) fails(() => store.create('alice', value));
  const invalid = [
    { notes: null }, { notes: '甲'.repeat(4001) }, { noticeId: 2 }, { noticeId: '甲'.repeat(161) },
    { status: '' }, { status: 'deleted' }, { priority: 'urgent' }, { priority: null },
    { dueDate: '2026-02-29' }, { dueDate: '2026-04-31' }, { dueDate: '2026-1-01' }, { dueDate: null },
    { plannedDate: '2026-02-30' }, { plannedStartTime: '09:00' }, { plannedEndTime: '12:00' },
    { plannedDate: '2026-10-19', plannedStartTime: '9:00' },
    { plannedDate: '2026-10-19', plannedStartTime: '24:00' },
    { plannedDate: '2026-10-19', plannedStartTime: '12:00', plannedEndTime: '12:00' },
    { plannedDate: '2026-10-19', plannedStartTime: '23:00', plannedEndTime: '01:00' },
    { estimatedMinutes: -1 }, { estimatedMinutes: 10081 }, { estimatedMinutes: 1.5 }, { estimatedMinutes: '30' },
    { id: 'spoofed' }, { version: 1 }, { completedAt: 1 }, { createdAt: 1 }, { unknown: 'value' },
  ];
  for (const patch of invalid) fails(() => store.create('alice', { title: '坏任务', ...patch }));
  for (const options of [null, [], { status: 'deleted' }, { query: 2 }, { query: '甲'.repeat(201) }, { owner: 'bob' }]) fails(() => store.list('alice', options));
  assert.equal(store.list('alice').tasks.length, 0);
});

test('任务、引用和历史按账号隔离，删除通知仍可更新已有任务状态', t => {
  const { store, sqlite } = fixture(t);
  addNotice(sqlite, 'alice', 'alice-notice'); addNotice(sqlite, 'bob', 'bob-notice');
  fails(() => store.create('alice', { title: '越权关联', noticeId: 'bob-notice' }), 404);
  fails(() => store.create('alice', { title: '失效关联', noticeId: 'missing' }), 404);
  const task = store.create('alice', { title: '通知相关任务', noticeId: 'alice-notice' }).task;
  assert.equal(store.list('bob').tasks.length, 0);
  fails(() => store.update('bob', task.id, { status: 'done' }, task.version), 404);
  fails(() => store.update('alice', task.id, { noticeId: 'bob-notice' }, task.version), 404);
  sqlite.prepare('DELETE FROM notices WHERE owner_id = ? AND id = ?').run('alice', 'alice-notice');
  const completed = store.update('alice', task.id, { status: 'done' }, task.version).task;
  assert.equal(completed.noticeId, 'alice-notice'); assert.equal(completed.status, 'done');
  const today = store.list('alice').today;
  const otherReview = store.review('bob', { from: today, to: today });
  assert.deepEqual(otherReview.changes, []); assert.deepEqual(otherReview.completed, []);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS total FROM task_history WHERE owner_id = ?').get('alice').total, 2);
});

test('创建活跃同名同通知任务幂等，完成或取消后可以新建与恢复', t => {
  const { store } = fixture(t);
  const original = store.create('alice', { title: '同名任务', notes: '必须保留' }).task;
  const duplicate = store.create('alice', { title: ' 同名任务 ', notes: '不可覆盖', dueDate: '2026-10-25' });
  assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.task, original);
  assert.equal(store.create('bob', { title: '同名任务' }).duplicate, false);
  let cancelled = store.update('alice', original.id, { status: 'cancelled' }, original.version).task;
  assert.equal(cancelled.completedAt, null);
  const newTask = store.create('alice', { title: '同名任务' }).task;
  assert.notEqual(newTask.id, original.id);
  cancelled = store.update('alice', cancelled.id, { status: 'in_progress' }, cancelled.version).task;
  assert.equal(cancelled.status, 'in_progress');
  const done = store.update('alice', newTask.id, { status: 'done' }, newTask.version).task;
  assert.equal(typeof done.completedAt, 'number');
  const preserved = store.update('alice', done.id, { notes: '完成后备注' }, done.version).task;
  assert.equal(preserved.completedAt, done.completedAt);
  const reopened = store.update('alice', done.id, { status: 'todo' }, preserved.version).task;
  assert.equal(reopened.completedAt, null);
});

test('版本冲突与失败校验不会覆盖任务，也不会留下虚假历史', t => {
  const { store, sqlite } = fixture(t);
  const task = store.create('alice', { title: '原始任务' }).task;
  fails(() => store.update('alice', task.id, { notes: '缺版本' }), 400);
  fails(() => store.update('alice', task.id, { notes: '过期版本' }, 0), 409);
  fails(() => store.update('alice', task.id, { notes: '坏参数', dueDate: '明天' }, 1));
  const next = store.update('alice', task.id, { notes: '更新备注' }, 1).task;
  assert.equal(next.version, 2);
  fails(() => store.update('alice', task.id, { title: '覆盖新值' }, 1), 409);
  assert.deepEqual(store.list('alice').tasks, [next]);
  const history = sqlite.prepare('SELECT before_data, after_data FROM task_history WHERE owner_id = ? ORDER BY id').all('alice');
  assert.equal(history.length, 2); assert.equal(history[0].before_data, null);
  assert.deepEqual(JSON.parse(history[1].before_data), task); assert.deepEqual(JSON.parse(history[1].after_data), next);
});

test('时间偏好支持部分修改、学期和节次表，执行隔离与乐观版本校验', t => {
  const { store } = fixture(t);
  const defaults = store.settings('alice');
  assert.deepEqual(defaults, { timeZone: 'Asia/Shanghai', dailyCapacityMinutes: 120, bufferMinutes: 15, dayStart: '08:00', dayEnd: '22:00', notes: '', semesterStart: '', semesterEnd: '', classPeriods: [], version: 0 });
  defaults.classPeriods.push({ period: 1, start: '01:00', end: '02:00' });
  assert.deepEqual(store.settings('alice').classPeriods, []);
  fails(() => store.saveSettings('alice', { notes: '无版本' }));
  fails(() => store.saveSettings('alice', { notes: '错误初始版本' }, 1), 409);
  const settings = store.saveSettings('alice', {
    dailyCapacityMinutes: 0, bufferMinutes: 180, dayStart: '00:00', dayEnd: '23:59', notes: '  每周复盘  ', semesterStart: '2026-09-02', semesterEnd: '2027-01-20',
    classPeriods: [{ period: 2, start: '08:45', end: '09:30' }, { period: 1, start: '08:00', end: '08:45' }],
  }, 0);
  assert.equal(settings.version, 1); assert.equal(settings.notes, '每周复盘'); assert.equal(settings.semesterStart, '2026-09-02');
  assert.deepEqual(settings.classPeriods.map(value => value.period), [1, 2]);
  const next = store.saveSettings('alice', { dailyCapacityMinutes: 1440 }, 1);
  assert.equal(next.version, 2); assert.equal(next.semesterEnd, '2027-01-20');
  fails(() => store.saveSettings('alice', { notes: '过期' }, 1), 409);
  assert.equal(store.settings('bob').version, 0);
  const invalid = [
    { timeZone: 'UTC' }, { dailyCapacityMinutes: -1 }, { dailyCapacityMinutes: 1441 }, { dailyCapacityMinutes: 1.5 }, { bufferMinutes: 181 },
    { dayStart: '' }, { dayEnd: '24:00' }, { dayStart: '10:00', dayEnd: '10:00' }, { notes: '甲'.repeat(2001) }, { version: 3 },
    { semesterStart: '2026-02-29' }, { semesterEnd: '2026-01-01' }, { semesterStart: null },
    { classPeriods: null }, { classPeriods: Array.from({ length: 31 }, () => ({ period: 1, start: '08:00', end: '09:00' })) },
    { classPeriods: [{ period: 0, start: '08:00', end: '09:00' }] }, { classPeriods: [{ period: 31, start: '08:00', end: '09:00' }] },
    { classPeriods: [{ period: 1, start: '9:00', end: '10:00' }] }, { classPeriods: [{ period: 1, start: '09:00', end: '09:00' }] },
    { classPeriods: [{ period: 1, start: '08:00', end: '09:00' }, { period: 1, start: '09:00', end: '10:00' }] },
    { classPeriods: [{ period: 1, start: '08:00', end: '09:00' }, { period: 2, start: '08:30', end: '09:30' }] },
  ];
  for (const patch of invalid) fails(() => store.saveSettings('alice', patch, 2));
  assert.deepEqual(store.settings('alice'), next);
  assert.equal(store.saveSettings('bob', { semesterEnd: '2027-02-01' }, 0).semesterStart, '');
});

test('周期复盘按北京时间含首尾日期，区分当前完成、安排、到期和逾期', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-18T15:59:59.999Z') });
  const { store } = fixture(t);
  const early = store.create('alice', { title: '窗口前已完成', status: 'done' }).task;
  let work = store.create('alice', { title: '窗口中完成', plannedDate: '2026-10-19', plannedStartTime: '09:00', plannedEndTime: '10:00', dueDate: '2026-10-19', estimatedMinutes: 999 }).task;
  store.create('alice', { title: '已取消不算逾期', dueDate: '2026-10-18', status: 'cancelled' });
  t.mock.timers.tick(1);
  work = store.update('alice', work.id, { status: 'done' }, 1).task;
  const overdue = store.create('alice', { title: '早已到期', dueDate: '2026-10-18' }).task;
  const due = store.create('alice', { title: '今日到期', dueDate: '2026-10-19' }).task;
  store.create('bob', { title: '其他账号完成', status: 'done' });
  t.mock.timers.tick(86400000 - 1);
  const last = store.create('alice', { title: '窗口最后一毫秒', status: 'done' }).task;
  const window = { from: '2026-10-19', to: '2026-10-19' };
  let review = store.review('alice', window);
  assert.equal(review.today, '2026-10-19'); assert.equal(review.timeZone, 'Asia/Shanghai');
  assert.equal(review.from, window.from); assert.equal(review.to, window.to);
  assert.deepEqual(new Set(review.completed.map(task => task.id)), new Set([work.id, last.id]));
  assert.ok(!review.completed.some(task => task.id === early.id));
  assert.deepEqual(review.scheduled.map(task => task.id), [work.id]);
  assert.deepEqual(new Set(review.due.map(task => task.id)), new Set([work.id, due.id]));
  assert.deepEqual(review.overdue.map(task => task.id), [overdue.id]);
  assert.deepEqual(review.statusCounts, { todo: 2, in_progress: 0, done: 2, cancelled: 0 });
  assert.equal(review.changes.length, 4); assert.equal(review.changesTruncated, false);
  assert.match(review.estimatedMinutesNote, /不代表实际工作量/);
  t.mock.timers.tick(1);
  store.create('alice', { title: '窗口后的完成', status: 'done' });
  store.update('alice', work.id, { status: 'todo' }, work.version);
  review = store.review('alice', window);
  assert.deepEqual(review.completed.map(task => task.id), [last.id]);
  assert.equal(review.statusCounts.todo, 3);
  assert.ok(review.changes.some(change => change.taskId === work.id && change.before.status === 'todo' && change.after.status === 'done'));
  assert.equal(review.changes.length, 4);
  assert.ok(review.overdue.some(task => task.id === due.id));
  for (const range of [undefined, {}, { from: '', to: '' }, { from: '2026-02-29', to: '2026-10-19' }, { from: '2026-10-20', to: '2026-10-19' }, { from: '2025-01-01', to: '2026-01-02' }]) fails(() => store.review('alice', range));
  assert.equal(store.review('alice', { from: '2024-01-01', to: '2024-12-31' }).changes.length, 0);
});

test('复盘历史最多返回 200 条且明确截断，排序保留最新版本', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-19T00:00:00Z') });
  const { store } = fixture(t);
  let task = store.create('alice', { title: '多次调整' }).task;
  for (let index = 0; index < 205; index++) task = store.update('alice', task.id, { notes: `第${index}次` }, task.version).task;
  const review = store.review('alice', { from: '2026-10-19', to: '2026-10-19' });
  assert.equal(review.changes.length, 200); assert.equal(review.changesTruncated, true);
  assert.equal(review.changes[0].after.version, 206); assert.equal(review.changes.at(-1).after.version, 7);
  assert.equal(review.statusCounts.todo, 1);
});

test('重新打开数据库后任务、偏好、版本与历史仍然持久保存', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhihui-task-test-'));
  const filename = join(directory, 'test.sqlite');
  let database = openDatabase(filename);
  try {
    database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 'alice@example.test', 'fixture-only', 0);
    const store = createTaskStore(database.sqlite);
    const task = store.create('alice', { title: '需要持久化', notes: '关闭后保留', plannedDate: '2026-10-19' }).task;
    const settings = store.saveSettings('alice', { notes: '周日晚上复盘', semesterStart: '2026-09-01', classPeriods: [{ period: 1, start: '08:00', end: '08:45' }] }, 0);
    database.close(); database = openDatabase(filename);
    const reopened = createTaskStore(database.sqlite);
    assert.deepEqual(reopened.list('alice').tasks, [task]); assert.deepEqual(reopened.settings('alice'), settings);
    const today = reopened.list('alice').today;
    assert.equal(reopened.review('alice', { from: today, to: today }).changes.length, 1);
    assert.equal(reopened.update('alice', task.id, { status: 'in_progress' }, task.version).task.version, 2);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS total FROM standalone_migrations WHERE name = 'standalone/migrations/0005_tasks.sql'").get().total, 1);
  } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
});
