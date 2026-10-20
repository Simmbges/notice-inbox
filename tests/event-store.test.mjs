import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { openDatabase } from '../standalone/database.mjs';
import { createEventStore } from '../standalone/event-store.mjs';
import { createTaskStore } from '../standalone/task-store.mjs';
import { createCategoryStore } from '../standalone/categories.mjs';
import { DatabaseSync } from 'node:sqlite';
import { importNotices } from '../lib/notice-store.ts';
import { createPlanner } from '../standalone/planner-api.mjs';

const plain = value => JSON.parse(JSON.stringify(value));
const scope = {};
runInNewContext(readFileSync(new URL('../public/event-rules.js', import.meta.url), 'utf8'), scope);
const rules = scope.ZhihuiEventRules;
const event = (patch = {}) => ({ title: '高等数学', date: '2026-09-02', time: '08:00', endTime: '09:40', ...patch });
const course = (recurrence = {}, patch = {}) => event({ recordType: 'course', recurrence: { until: '2026-12-31', weekdays: [1, 3], ...recurrence }, ...patch });
const days = events => plain(events.map(value => value.date));
function fixture() {
  const database = openDatabase(':memory:');
  for (const owner of ['alice', 'bob']) database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(owner, `${owner}@example.test`, 'fixture-password-hash', 1);
  return { database, store: createEventStore(database.sqlite), close: database.close };
}

test('纯规则脚本支持单次旧字段、跨日、星期、单双周、指定周次、结束与排除', () => {
  const once = rules.normalizeEvent(event({ evidence: '通知原文', recurrence: null }));
  assert.equal(once.evidence, '通知原文'); assert.equal(once.recurrence, null);
  assert.deepEqual(days(rules.expandEvent(event({ date: '2026-08-30', endDate: '2026-09-03', endTime: '' }), '2026-09-01', '2026-09-04')), ['2026-08-30']);
  const ongoing = rules.expandEvent(event({ date: '2026-08-30', endDate: '2026-09-03', endTime: '' }), '2026-09-01', '2026-09-04')[0];
  assert.equal(ongoing.displayDate, '2026-09-01'); assert.equal(ongoing.ongoing, true);
  assert.deepEqual(days(rules.expandEvent(course(), '2026-08-31', '2026-09-16')), ['2026-09-02', '2026-09-07', '2026-09-09', '2026-09-14', '2026-09-16']);
  assert.deepEqual(days(rules.expandEvent(course({ intervalWeeks: 2 }), '2026-08-31', '2026-09-16')), ['2026-09-02', '2026-09-14', '2026-09-16']);
  assert.deepEqual(days(rules.expandEvent(course({ intervalWeeks: 2, weeks: [2, 3] }), '2026-08-31', '2026-09-30')), ['2026-09-14', '2026-09-16']);
  assert.deepEqual(days(rules.expandEvent(course({ weeks: [2, 4], until: '2026-09-22', excludeDates: ['2026-09-09'] }), '2026-08-31', '2026-09-30')), ['2026-09-07', '2026-09-21']);
  assert.deepEqual(days(rules.expandEvent(course({ weekdays: [7], until: '2026-09-13' }), '2026-09-01', '2026-09-30')), ['2026-09-06', '2026-09-13']);
  assert.equal(rules.normalizeEvent(course({}, { endDate: '2026-09-02' })).endDate, '');
  assert.deepEqual(plain(rules.normalizeEvent(course({ weekdays: [3, 1, 3], weeks: [3, 2, 3], excludeDates: ['2026-09-09', '2026-09-09'] })).recurrence), { until: '2026-12-31', weekdays: [1, 3], intervalWeeks: 1, weeks: [2, 3], excludeDates: ['2026-09-09'] });
});

test('规则拒绝猜日期、错误时间、跨天周期、超长范围和不合法周次', () => {
  const invalid = [
    event({ date: '' }), event({ date: '2026-02-29' }), event({ time: '24:00' }), event({ time: '', endTime: '10:00' }),
    event({ endTime: '08:00' }), event({ endTime: '07:59' }), event({ kind: 'deadline' }),
    course({ until: '' }), course({ until: '2026-09-01' }), course({ until: '2031-09-03' }),
    course({ weekdays: [] }), course({ weekdays: [0] }), course({ weekdays: [8] }),
    course({ intervalWeeks: 0 }), course({ intervalWeeks: 53 }), course({ weeks: [0] }), course({ weeks: [61] }),
    course({ weeks: '1,3' }), course({ excludeDates: ['2026-02-30'] }), course({}, { endDate: '2026-09-03' }),
  ];
  for (const value of invalid) assert.throws(() => rules.normalizeEvent(value), JSON.stringify(value));
  assert.equal(rules.normalizeEvent(event({ time: '', endTime: '' })).time, '');
  assert.doesNotThrow(() => rules.normalizeEvent(course({ until: '2031-09-02' })));
  for (const [from, to] of [['2026-02-30', '2026-03-02'], ['2026-09-03', '2026-09-02'], ['2026-01-01', '2027-01-02']]) assert.throws(() => rules.expandEvent(event(), from, to));
  assert.doesNotThrow(() => rules.expandEvent(event(), '2026-01-01', '2027-01-01'));
});

test('日期未知的事件可暂存，不能只有时分或周期，补日期后沿用编号和版本', () => {
  const { store, close } = fixture();
  try {
    const input = { title: '稍后确认的讨论', sourceUrl: 'https://example.test/meeting' };
    const created = store.import('alice', [input]).created[0];
    assert.equal(created.date, ''); assert.equal(created.participation, 'planned');
    assert.equal(store.overview('alice')[0].scheduleStatus, 'undated');
    assert.deepEqual(store.occurrences('alice', { from: '2026-10-19', to: '2026-10-25' }).events, []);
    for (const patch of [{ time: '09:00' }, { endDate: '2026-10-22' }, { endTime: '10:00' }, { recurrence: { until: '2026-10-31', weekdays: [1] } }, { participation: 'yes' }, { sourceUrl: 'javascript:alert(1)' }]) assert.throws(() => store.update('alice', created.id, patch, created.version), { status: 400 });
    const dated = store.update('alice', created.id, { date: '2026-10-21', participation: 'reference' }, created.version);
    assert.equal(dated.id, created.id); assert.equal(dated.version, created.version + 1);
    assert.equal(dated.sourceUrl, input.sourceUrl);
    const occurrence = store.occurrences('alice', { from: '2026-10-19', to: '2026-10-25' }).events[0];
    assert.equal(occurrence.participation, 'reference'); assert.equal(occurrence.occupiesTime, false);
    const undated = store.update('alice', dated.id, { date: '' }, dated.version);
    assert.equal(undated.id, created.id); assert.equal(store.overview('alice')[0].scheduleStatus, 'undated');
    assert.equal(store.import('alice', [{ ...input, sourceUrl: 'https://example.test/changed' }]).skipped, 1);
    const series = store.import('alice', [course({ weekdays: [1], until: '2026-10-26' }, { date: '2026-10-19' })]).created[0];
    const moved = store.changeOccurrence('alice', series.id, series.version, '2026-10-19', { date: '2026-10-20' });
    const reference = store.update('alice', series.id, { participation: 'reference' }, moved.event.version);
    const child = store.list('alice').find(value => value.seriesId === series.id);
    assert.equal(reference.participation, 'reference'); assert.equal(child.participation, 'reference');
    assert.throws(() => store.update('alice', child.id, { participation: 'planned' }, child.version), { status: 400 });
  } finally { close(); }
});

test('两种存储共同筛选课程与事件，周期资料不变成个人承诺，时间修改保留原记录和元数据', async () => {
  const { store, database, close } = fixture();
  try {
    const planner = createPlanner(database.sqlite);
    const source = { title: '校园公开课与报名', content: '保留原文', summary: '公开课资料', sourceUrl: 'https://example.test/course', audience: '全校学生', publishedAt: '2026-10-18', recordType: 'course', events: [{ title: '公开课', date: '2026-10-19', time: '09:00', endTime: '10:00', evidence: '每周一9时', recurrence: { until: '2026-11-02', weekdays: [1], excludeDates: ['2026-10-26'] } }, { title: '报名截止', kind: 'deadline', date: '2026-10-20', evidence: '20日截止' }] };
    const saved = (await importNotices(database.db, 'alice', [source])).created[0];
    await importNotices(database.db, 'bob', [{ ...source, title: '其他账号的课程' }]);
    const manual = (await importNotices(database.db, 'alice', [{ title: '已安排报告', participation: 'planned', events: [{ title: '已安排报告', date: '2026-10-21' }] }])).created[0];
    store.import('alice', [event({ title: '私人课', recordType: 'course', date: '2026-10-22' }), event({ title: '锻炼', date: '2026-10-23' })]);
    createTaskStore(database.sqlite).create('alice', { title: '完成作业', plannedDate: '2026-10-24' });
    const range = { from: '2026-10-19', to: '2026-11-02' };
    const courses = store.occurrences('alice', { ...range, recordType: 'course' }).events;
    assert.equal(courses.length, 4); assert.ok(courses.every(value => value.recordType === 'course' && value.sourceType !== 'task'));
    const repeated = store.occurrences('alice', { ...range, type: 'recurring' }).events;
    assert.deepEqual(repeated.map(value => value.date), ['2026-10-19', '2026-11-02']);
    assert.ok(repeated.every(value => value.noticeId === saved.id && value.sourceType === 'notice' && value.participation === 'reference' && !value.occupiesTime));
    const schedules = store.occurrences('alice', { ...range, recordType: 'schedule' }).events;
    assert.equal(schedules.length, 2); assert.ok(schedules.every(value => value.sourceType !== 'task' && value.recordType === 'schedule'));
    assert.ok(schedules.find(value => value.noticeId === manual.id).occupiesTime);
    assert.equal(store.occurrences('alice', range).events.filter(value => value.sourceType === 'task').length, 1);
    const row = database.sqlite.prepare('SELECT updated_at FROM notices WHERE owner_id = ? AND id = ?').get('alice', saved.id);
    const changed = planner.call('alice', 'update_notice_events', { id: saved.id, expectedUpdatedAt: row.updated_at, events: source.events.map((value, index) => index ? value : { ...value, recurrence: null }) });
    assert.equal(changed.notice.id, saved.id); assert.equal(changed.notice.events.length, 2);
    for (const key of ['content', 'summary', 'sourceUrl', 'audience', 'publishedAt']) assert.equal(changed.notice[key], source[key]);
    assert.equal(changed.notice.events[0].evidence, source.events[0].evidence);
    assert.equal(store.occurrences('alice', { ...range, type: 'recurring' }).total, 0);
    assert.throws(() => planner.call('bob', 'update_notice_events', { id: saved.id, expectedUpdatedAt: row.updated_at, events: [] }), { status: 404 });
    database.sqlite.prepare("UPDATE notices SET data = json_set(data, '$.active', json('false')) WHERE owner_id = ? AND id = ?").run('alice', saved.id);
    assert.ok(store.occurrences('alice', range).events.every(value => value.noticeId !== saved.id));
  } finally { close(); }
});

test('原子导入最多100项，指纹覆盖周期且不受原文变动影响，重复返回真实ID', () => {
  const { store, close } = fixture();
  try {
    const imported = store.import('alice', [course({}, { id: 'math', sourceText: '第一版原文' }), course({ intervalWeeks: 2 })]);
    assert.equal(imported.imported, 2);
    const repeated = store.import('alice', [course({}, { id: 'new-id', sourceText: '再次粘贴后的原文' }), course({}, { sourceText: '第三版' })]);
    assert.deepEqual(repeated.duplicates.map(value => value.id), ['math', 'math']);
    assert.equal(repeated.skipped, 2);
    assert.equal(store.list('alice').length, 2);
    assert.throws(() => store.import('alice', [event({ title: '不能落盘' }), event({ date: '2026-02-30' })]), { status: 400 });
    assert.throws(() => store.import('alice', [event({ title: '应回滚' }), event({ id: 'math', title: '编号冲突' })]), { status: 409 });
    assert.equal(store.list('alice').length, 2);
    assert.throws(() => store.import('alice', Array.from({ length: 101 }, (_, index) => event({ title: `事件${index}` }))), { status: 400 });
    assert.equal(store.import('bob', Array.from({ length: 100 }, (_, index) => event({ title: `事件${index}` }))).created.length, 100);
  } finally { close(); }
});

test('展开后统一排序分页，同日多课保留唯一发生ID且分页不截断总数', () => {
  const { store, close } = fixture();
  try {
    store.import('alice', [course({ until: '2026-09-30' }), course({ until: '2026-09-30' }, { time: '10:00', endTime: '11:40' }), event({ title: '报名截止', date: '2026-09-09', time: '', endTime: '', kind: 'deadline' })]);
    const first = store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', limit: 4 });
    assert.equal(first.total, 19); assert.equal(first.events.length, 4); assert.equal(first.hasMore, true); assert.equal(first.timeZone, 'Asia/Shanghai');
    assert.deepEqual(first.events.slice(0, 2).map(value => value.time), ['08:00', '10:00']);
    const all = [];
    for (let offset = 0; offset < first.total; offset += 4) all.push(...store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', limit: 4, offset }).events);
    assert.equal(new Set(all.map(value => value.id)).size, 19);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', kind: 'deadline' }).total, 1);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', type: 'once' }).total, 1);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', type: 'recurring', query: '数学' }).total, 18);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', offset: 19 }).hasMore, false);
    for (const options of [{ from: 'bad' }, { from: '2026-02-30' }, { limit: 201 }, { offset: -1 }, { type: 'weekly' }, { from: '2026-01-01', to: '2027-01-02' }]) assert.throws(() => store.occurrences('alice', options), { status: 400 });
  } finally { close(); }
});

test('通知关联只允许当前owner，新建及换链接校验，历史通知删除后仍可普通编辑', () => {
  const { store, database, close } = fixture();
  try {
    const add = (owner, id) => database.sqlite.prepare('INSERT INTO notices VALUES (?, ?, ?, ?, ?, ?)').run(owner, id, id, JSON.stringify({ id, title: '来源通知', events: [] }), 1, 1);
    add('alice', 'alice-notice'); add('bob', 'bob-notice');
    assert.throws(() => store.import('alice', [event({ title: '整批不能落盘' }), event({ noticeId: 'bob-notice' })]), { status: 404 });
    assert.throws(() => store.import('alice', [event({ noticeId: 'missing' })]), { status: 404 });
    assert.equal(store.list('alice').length, 0);
    const original = store.import('alice', [event({ noticeId: 'alice-notice' })]).created[0];
    assert.throws(() => store.update('alice', original.id, { noticeId: 'bob-notice' }, 1), { status: 404 });
    assert.equal(store.list('alice')[0].version, 1);
    database.sqlite.prepare('DELETE FROM notices WHERE owner_id = ? AND id = ?').run('alice', 'alice-notice');
    assert.equal(store.import('alice', [event({ noticeId: 'alice-notice', sourceText: '重导已删除的历史来源' })]).duplicates[0].id, original.id);
    const updated = store.update('alice', original.id, { notes: '删除通知后继续编辑', noticeId: 'alice-notice' }, 1);
    assert.equal(updated.noticeId, 'alice-notice'); assert.equal(updated.version, 2);
    assert.equal(store.update('alice', original.id, { noticeId: '' }, 2).noticeId, '');
  } finally { close(); }
});

test('停课或调课后重导原课表仍复用原系列，并保留排除日期和取消状态', () => {
  const { store, close } = fixture();
  try {
    const input = course({ until: '2026-09-30' }, { sourceText: '原课表截图' });
    const original = store.import('alice', [input]).created[0];
    store.changeOccurrence('alice', original.id, 1, '2026-09-07', null);
    const adjusted = store.changeOccurrence('alice', original.id, 2, '2026-09-09', { date: '2026-09-10' });
    assert.equal(adjusted.created.time, '08:00'); assert.equal(adjusted.created.endTime, '09:40');
    const repeated = store.import('alice', [{ ...input, sourceText: '重新识别的原课表' }]);
    assert.equal(repeated.imported, 0); assert.equal(repeated.duplicates[0].id, original.id);
    assert.equal(store.list('alice').length, 2);
    assert.deepEqual(store.list('alice').find(value => value.id === original.id).recurrence.excludeDates, ['2026-09-07', '2026-09-09']);
    assert.equal(store.occurrences('alice', { from: '2026-09-07', to: '2026-09-09' }).total, 0);
    assert.equal(store.occurrences('alice', { from: '2026-09-10', to: '2026-09-10' }).total, 1);
    store.update('alice', original.id, { active: false }, 3);
    assert.equal(store.import('alice', [input]).duplicates[0].id, original.id);
    assert.equal(store.list('alice').find(value => value.id === original.id).active, false);
    assert.equal(store.occurrences('alice', { from: '2026-09-14', to: '2026-09-16' }).total, 0);
  } finally { close(); }
});

test('旧通知安排和旧截止日期在服务端合并，同日明确截止避免重复，owner独立', () => {
  const { store, database, close } = fixture();
  try {
    const add = (owner, value) => database.sqlite.prepare('INSERT INTO notices VALUES (?, ?, ?, ?, ?, ?)').run(owner, value.id, value.id, JSON.stringify(value), 1, 1);
    add('alice', { id: 'legacy', title: '旧报名', deadline: '2026-09-09', content: '旧原文' });
    add('alice', { id: 'modern', title: '新报名', deadline: '2026-09-09', location: '教学楼', events: [event({ kind: 'deadline', date: '2026-09-09', time: '17:00', endTime: '', evidence: '九日17点截止' }), event({ title: '现场', date: '2026-09-10' })] });
    add('bob', { id: 'other', title: '他人安排', deadline: '2026-09-09' });
    store.import('alice', [course({ until: '2026-09-10' })]);
    const result = store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30' });
    assert.equal(result.total, 6);
    const old = result.events.find(value => value.noticeId === 'legacy');
    assert.equal(old.time, ''); assert.equal(old.kind, 'deadline'); assert.equal(old.sourceType, 'notice');
    assert.equal(result.events.find(value => value.noticeId === 'modern').location, '教学楼');
    assert.equal(result.events.filter(value => value.kind === 'deadline').length, 2);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', type: 'recurring' }).total, 3);
    assert.equal(store.occurrences('bob', { from: '2026-09-01', to: '2026-09-30' }).total, 1);
  } finally { close(); }
});

test('版本冲突阻止覆盖，取消恢复，跨owner更新失败，单次调停课只影响命中日期', () => {
  const { store, close } = fixture();
  try {
    const original = store.import('alice', [course({ until: '2026-09-30' })]).created[0];
    assert.throws(() => store.update('bob', original.id, { title: '篡改' }, 1), { status: 404 });
    assert.throws(() => store.update('alice', original.id, { title: '无版本' }), { status: 400 });
    const revised = store.update('alice', original.id, { location: 'A101' }, 1);
    assert.equal(revised.version, 2); assert.equal(revised.revision, 2); assert.ok(revised.updatedAt > original.updatedAt);
    assert.throws(() => store.update('alice', original.id, { title: '过期修改' }, 1), { status: 409 });
    assert.throws(() => store.changeOccurrence('alice', original.id, 2, '2026-09-03', null), { status: 400 });
    const cancelled = store.changeOccurrence('alice', original.id, 2, '2026-09-07', null);
    assert.equal(cancelled.created, null); assert.equal(cancelled.event.version, 3);
    assert.throws(() => store.changeOccurrence('alice', original.id, 3, '2026-09-07', null), { status: 400 });
    const moved = store.changeOccurrence('alice', original.id, 3, '2026-09-09', { date: '2026-10-02', time: '12:00', endTime: '13:00', location: 'B201' });
    assert.equal(moved.created.recurrence, null); assert.equal(moved.created.location, 'B201'); assert.equal(moved.created.date, '2026-10-02');
    assert.equal(store.occurrences('alice', { from: '2026-09-07', to: '2026-09-13' }).total, 0);
    assert.equal(store.occurrences('alice', { from: '2026-09-14', to: '2026-09-20' }).total, 2);
    assert.equal(store.occurrences('alice', { from: '2026-10-01', to: '2026-10-02' }).total, 1);
    const intoRange = store.changeOccurrence('alice', original.id, 4, '2026-09-21', { date: '2026-10-01' });
    assert.equal(store.occurrences('alice', { from: '2026-10-01', to: '2026-10-02' }).total, 2);
    const paused = store.update('alice', original.id, { active: false }, intoRange.event.version);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30' }).total, 0);
    assert.ok(store.list('alice').find(value => value.id === original.id));
    store.update('alice', original.id, { active: true }, paused.version);
    assert.equal(store.occurrences('alice', { from: '2026-09-14', to: '2026-09-20' }).total, 2);
    assert.throws(() => store.changeOccurrence('alice', original.id, paused.version + 1, '2026-09-14', { time: '18:00' }), { status: 400 });
    assert.equal(store.occurrences('alice', { from: '2026-09-14', to: '2026-09-14' }).total, 1);
  } finally { close(); }
});

test('个人任务计划和截止节点合并排序分页，完成保留状态，取消排除', () => {
  const { store, database, close } = fixture();
  try {
    const tasks = createTaskStore(database.sqlite);
    tasks.create('alice', { title: '做实验', plannedDate: '2026-09-09', plannedStartTime: '10:00', plannedEndTime: '11:00', dueDate: '2026-09-09', priority: 'high', notes: '个人实验' });
    tasks.create('alice', { title: '已经完成', plannedDate: '2026-09-09', plannedStartTime: '12:00', plannedEndTime: '13:00', status: 'done' });
    tasks.create('alice', { title: '已取消任务', plannedDate: '2026-09-09', status: 'cancelled' });
    tasks.create('alice', { title: '未知日期' });
    tasks.create('bob', { title: '他人任务', dueDate: '2026-09-09' });
    store.import('alice', [event({ date: '2026-09-09' })]);
    const result = store.occurrences('alice', { from: '2026-09-09', to: '2026-09-09', limit: 2 });
    assert.equal(result.total, 4); assert.equal(result.hasMore, true);
    assert.deepEqual(result.events.map(value => value.sourceType), ['event', 'task']);
    const second = store.occurrences('alice', { from: '2026-09-09', to: '2026-09-09', offset: 2, limit: 2 });
    assert.equal(second.events[0].status, 'done'); assert.equal(second.events[0].occupiesTime, false);
    assert.equal(second.events[1].taskNode, 'due'); assert.equal(second.events[1].time, '');
    const planned = result.events[1];
    assert.equal(planned.notes, '个人实验'); assert.equal(planned.priority, 'high'); assert.equal(planned.occupiesTime, true);
    assert.notEqual(planned.id, second.events[1].id); assert.equal(planned.taskId, second.events[1].taskId);
    assert.equal(store.occurrences('alice', { from: '2026-09-09', to: '2026-09-09', type: 'once', kind: 'deadline' }).total, 1);
    assert.equal(store.occurrences('alice', { from: '2026-09-09', to: '2026-09-09', query: '个人实验' }).total, 2);
    assert.equal(store.occurrences('bob', { from: '2026-09-09', to: '2026-09-09' }).total, 1);
  } finally { close(); }
});

test('重启后保留周期规则、排除日、版本和单次调课，且数据按owner隔离', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-event-store-test-'));
  const filename = join(directory, 'events.sqlite');
  let database = openDatabase(filename);
  try {
    database.sqlite.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 'alice@example.test', 'fixture-password-hash', 1);
    let store = createEventStore(database.sqlite);
    const original = store.import('alice', [course({ intervalWeeks: 2 })]).created[0];
    store.changeOccurrence('alice', original.id, 1, '2026-09-02', { date: '2026-09-03' });
    database.close(); database = openDatabase(filename); store = createEventStore(database.sqlite);
    const events = store.list('alice');
    assert.equal(events.length, 2); assert.equal(events.find(value => value.id === original.id).version, 2);
    assert.deepEqual(events.find(value => value.id === original.id).recurrence.excludeDates, ['2026-09-02']);
    assert.deepEqual(days(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-16' }).events), ['2026-09-03', '2026-09-14', '2026-09-16']);
    assert.deepEqual(store.list('bob'), []);
  } finally {
    database.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-event-store-test-')) rmSync(directory, { recursive: true, force: true });
  }
});

test('统一列表每个系列一张卡，下次发生按北京时间排除已结束课程并搜索整个周期', () => {
  const { store, close } = fixture();
  try {
    const imported = store.import('alice', [
      course({ until: '2026-11-30', weekdays: [1] }, { date: '2026-09-07' }),
      course({ until: '2026-12-31', weekdays: [1], intervalWeeks: 4 }, { title: '隔四周研讨', date: '2026-09-07' }),
      event({ title: '跨日活动', date: '2026-09-06', endDate: '2026-09-09', endTime: '18:00' }),
      event({ title: '很远的一次性安排', date: '2028-09-02' }),
      event({ title: '已结束安排', date: '2026-09-06' }),
      event({ title: '已取消安排', date: '2026-09-08', active: false }),
      course({ until: '2028-01-01', weekdays: [1], weeks: [60] }, { title: '第60周课程', date: '2026-09-07' }),
    ]);
    const overview = time => imported.created.map(event => store.overview('alice', Date.parse(`2026-09-07T${time}+08:00`)).find(value => value.id === event.id));
    assert.equal(overview('08:30').length, imported.imported);
    const current = overview('08:30')[0];
    assert.equal(current.scheduleStatus, 'ongoing'); assert.equal(current.nextOccurrence.date, '2026-09-07');
    const after = overview('09:40');
    assert.equal(after[0].scheduleStatus, 'upcoming'); assert.equal(after[0].nextOccurrence.date, '2026-09-14');
    assert.equal(after[1].nextOccurrence.date, '2026-10-05');
    assert.equal(after[2].scheduleStatus, 'ongoing'); assert.equal(after[2].nextOccurrence.date, '2026-09-06');
    assert.equal(after[3].nextOccurrence.date, '2028-09-02');
    assert.equal(after[4].scheduleStatus, 'ended'); assert.equal(after[4].nextOccurrence, null);
    assert.equal(after[5].scheduleStatus, 'cancelled'); assert.equal(after[5].nextOccurrence, null);
    assert.equal(after[6].nextOccurrence.date, rules.shiftDay('2026-09-07', 59 * 7));
    assert.equal(after[0].category, '课程'); assert.equal(after[0].favorite, false);
    assert.deepEqual(store.overview('bob'), []);
  } finally { close(); }
});

test('单次调课归属原系列卡，下次安排采用替代时间，取消恢复系列同时影响替代课次', () => {
  const { store, close } = fixture();
  try {
    let courseEvent = store.import('alice', [course({ until: '2026-09-14', weekdays: [1] }, { date: '2026-09-07' })]).created[0];
    const moved = store.changeOccurrence('alice', courseEvent.id, 1, '2026-09-07', { date: '2026-09-20', time: '14:00', endTime: '15:40', location: '新教室' });
    assert.equal(moved.created.seriesId, courseEvent.id); assert.equal(moved.created.originalDate, '2026-09-07');
    assert.equal(store.list('alice').length, 2);
    let overview = store.overview('alice', Date.parse('2026-09-15T08:00+08:00'));
    assert.equal(overview.length, 1); assert.equal(overview[0].id, courseEvent.id);
    assert.equal(overview[0].nextOccurrence.date, '2026-09-20'); assert.equal(overview[0].nextOccurrence.location, '新教室');
    courseEvent = store.update('alice', courseEvent.id, { active: false }, moved.event.version);
    assert.equal(store.overview('alice')[0].scheduleStatus, 'cancelled');
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30' }).total, 0);
    store.update('alice', courseEvent.id, { active: true }, courseEvent.version);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30' }).total, 2);
    assert.throws(() => store.update('alice', moved.created.id, { seriesId: 'foreign' }, 1), { status: 400 });
    assert.throws(() => store.update('alice', moved.created.id, { recurrence: { until: '2026-12-01', weekdays: [1] } }, 1), { status: 400 });
  } finally { close(); }
});

test('日程分类与收藏可修改，去重不受归类影响，分类改名删除同步版本及默认映射', () => {
  const { store, database, close } = fixture();
  const categories = createCategoryStore(database.sqlite);
  try {
    categories.change('alice', 'POST', { name: '课程归档' });
    assert.throws(() => store.import('alice', [event({ category: '不存在' })]), { status: 400 });
    assert.throws(() => store.import('alice', [event({ favorite: 'true' })]), { status: 400 });
    let parent = store.import('alice', [course({ weekdays: [1] }, { date: '2026-09-07' })]).created[0];
    const moved = store.changeOccurrence('alice', parent.id, 1, '2026-09-07', { date: '2026-09-08' });
    parent = store.update('alice', parent.id, { category: '课程归档', favorite: true }, moved.event.version);
    const child = store.list('alice').find(value => value.seriesId === parent.id);
    assert.equal(child.category, '课程归档'); assert.equal(child.favorite, true); assert.equal(child.version, 2);
    assert.throws(() => store.update('alice', child.id, { category: '课程' }, child.version), error => error.status === 400 && /修改整个系列/.test(error.message));
    assert.throws(() => store.update('alice', child.id, { favorite: false }, child.version), error => error.status === 400 && /修改整个系列/.test(error.message));
    assert.equal(store.list('alice').find(value => value.id === child.id).version, child.version);
    const editedChild = store.update('alice', child.id, { category: child.category, favorite: child.favorite, location: '单次换教室' }, child.version);
    assert.equal(editedChild.category, '课程归档'); assert.equal(editedChild.favorite, true); assert.equal(editedChild.location, '单次换教室');
    assert.equal(store.import('alice', [course({ weekdays: [1] }, { date: '2026-09-07', category: '课程' })]).duplicates[0].id, parent.id);
    categories.change('alice', 'PATCH', { name: '课程归档', newName: '课程学习归档' });
    assert.ok(store.list('alice').every(value => value.category === '课程学习归档'));
    assert.ok(store.list('alice').every(value => value.favorite));
    assert.throws(() => store.update('alice', parent.id, { notes: '旧版本不能覆盖分类' }, parent.version), { status: 409 });
    categories.change('alice', 'PATCH', { name: '课程', newName: '我的课表' });
    assert.equal(store.import('alice', [event({ title: '新课程', recordType: 'course' })]).created[0].category, '我的课表');
    categories.change('alice', 'DELETE', { name: '我的课表' });
    assert.equal(store.import('alice', [event({ title: '删除分类后新课程', recordType: 'course' })]).created[0].category, '其他通知');
    assert.ok(!categories.list('alice').includes('日程与课表'));
    assert.equal(store.import('bob', [event()]).created[0].category, '日程');
    categories.change('alice', 'DELETE', { name: '课程学习归档' });
    assert.ok(store.list('alice').every(value => value.category === '其他通知'));
  } finally { close(); }
});

test('升级迁移为旧日程补默认分类，复用已有同名分类且删除后重启不复活', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-event-category-migration-'));
  const filename = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('CREATE TABLE standalone_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const name of ['drizzle/0000_sparkling_frog_thor.sql', ...['0001_email_auth', '0002_agent_permissions', '0003_custom_categories', '0004_events', '0005_tasks', '0006_planner_permission'].map(value => `standalone/migrations/${value}.sql`)]) {
    legacy.exec(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO standalone_migrations VALUES (?, ?)').run(name, 1);
  }
  legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('alice', 'alice@example.test', 'fixture-hash', 1);
  legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('bob', 'bob@example.test', 'fixture-hash', 1);
  legacy.prepare('INSERT INTO notice_categories VALUES (?, ?)').run('alice', JSON.stringify(['自定义分类', '日程与课表', '其他通知']));
  legacy.prepare('INSERT INTO notice_categories VALUES (?, ?)').run('bob', JSON.stringify(['旧分类', '其他通知']));
  const input = rules.normalizeEvent(event({ id: 'legacy-course' }));
  delete input.category; delete input.favorite; delete input.recordType;
  legacy.prepare('INSERT INTO notice_events VALUES (?, ?, ?, ?, ?, ?, ?)').run('alice', input.id, 'fixture-hash', JSON.stringify({ ...input, version: 1, revision: 1, createdAt: 1, updatedAt: 1 }), 1, 1, 1);
  legacy.close();
  let database = openDatabase(filename);
  try {
    let categoryStore = createCategoryStore(database.sqlite), store = createEventStore(database.sqlite);
    assert.equal(categoryStore.list('alice').filter(name => name === '日程').length, 1);
    assert.equal(categoryStore.list('alice').at(-1), '其他通知');
    assert.deepEqual(categoryStore.list('bob'), ['旧分类', '日程', '课程', '其他通知']);
    assert.equal(store.list('alice')[0].category, '日程'); assert.equal(store.list('alice')[0].favorite, false);
    categoryStore.change('alice', 'DELETE', { name: '日程' });
    assert.equal(store.list('alice')[0].category, '其他通知'); assert.equal(store.list('alice')[0].version, 2);
    database.close(); database = openDatabase(filename);
    categoryStore = createCategoryStore(database.sqlite); store = createEventStore(database.sqlite);
    assert.ok(!categoryStore.list('alice').includes('日程与课表'));
    assert.equal(store.import('alice', [event({ title: '升级后新课' })]).created[0].category, '其他通知');
  } finally {
    database.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-event-category-migration-')) rmSync(directory, { recursive: true, force: true });
  }
});

test('课程与日程独立于重复方式，修改类型跟随默认分类且不复制记录，调课继承系列类型', () => {
  const { store, database, close } = fixture();
  const categories = createCategoryStore(database.sqlite);
  try {
    const weekly = course({ weekdays: [1] }, { title: '每周健身', date: '2026-09-07', recordType: 'schedule' });
    const once = event({ title: '补课', recordType: 'course' });
    const imported = store.import('alice', [weekly, once, event({ title: '未明确指定类型的新导入', sourceName: '课表截图' })]).created;
    let parent = imported[0];
    assert.equal(parent.recordType, 'schedule'); assert.equal(parent.category, '日程');
    const all = store.overview('alice', Date.parse('2026-09-01T00:00+08:00'));
    assert.deepEqual(imported.map(value => all.find(card => card.id === value.id)).map(value => [value.recordType, value.eventType, value.category]), [['schedule', 'recurring', '日程'], ['course', 'once', '课程'], ['schedule', 'once', '日程']]);
    assert.equal(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', recordType: 'course' }).total, 1);
    assert.ok(store.occurrences('alice', { from: '2026-09-01', to: '2026-09-30', recordType: 'schedule' }).events.every(value => value.recordType === 'schedule'));
    assert.throws(() => store.import('alice', [event({ recordType: 'recurring' })]), { status: 400 });
    assert.throws(() => store.occurrences('alice', { recordType: 'unknown' }), { status: 400 });
    const moved = store.changeOccurrence('alice', parent.id, 1, '2026-09-07', { date: '2026-09-08' });
    assert.equal(moved.created.recordType, 'schedule');
    parent = store.update('alice', parent.id, { recordType: 'course' }, moved.event.version);
    assert.equal(parent.category, '课程');
    const child = store.list('alice').find(value => value.seriesId === parent.id);
    assert.equal(child.recordType, 'course'); assert.equal(child.category, '课程');
    assert.throws(() => store.update('alice', child.id, { recordType: 'schedule' }, child.version), error => error.status === 400 && /修改整个系列/.test(error.message));
    assert.equal(store.import('alice', [weekly]).duplicates[0].id, parent.id);
    assert.equal(store.list('alice').length, 4);
    categories.change('alice', 'POST', { name: '自选分类' });
    parent = store.update('alice', parent.id, { category: '自选分类' }, parent.version);
    parent = store.update('alice', parent.id, { recordType: 'schedule' }, parent.version);
    assert.equal(parent.category, '自选分类');
    categories.change('alice', 'PATCH', { name: '课程', newName: '我的课程' });
    categories.change('alice', 'PATCH', { name: '日程', newName: '生活安排' });
    assert.equal(store.import('alice', [event({ title: '改名后的课程', recordType: 'course' })]).created[0].category, '我的课程');
    assert.equal(store.import('alice', [event({ title: '改名后的日程' })]).created[0].category, '生活安排');
    categories.change('alice', 'DELETE', { name: '我的课程' });
    assert.equal(store.import('alice', [event({ title: '分类删除后的课程', recordType: 'course' })]).created[0].category, '其他通知');
    assert.ok(!categories.list('alice').includes('课程'));
    assert.equal(categories.defaultCategory('bob', 'course'), '课程');
  } finally { close(); }
});

test('升级拆分混合分类，只用明确课表来源识别课程，保留自定义归类和旧调课关系', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-course-type-migration-'));
  const filename = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('CREATE TABLE standalone_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const name of ['drizzle/0000_sparkling_frog_thor.sql', ...['0001_email_auth', '0002_agent_permissions', '0003_custom_categories', '0004_events', '0005_tasks', '0006_planner_permission', '0007_schedule_categories'].map(value => `standalone/migrations/${value}.sql`)]) {
    legacy.exec(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO standalone_migrations VALUES (?, ?)').run(name, 1);
  }
  for (const owner of ['alice', 'renamed', 'deleted', 'unopened']) legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run(owner, `${owner}@example.test`, 'fixture-hash', 1);
  const addCategories = (owner, names, schedule) => legacy.prepare('INSERT INTO notice_categories (owner_id, names, schedule_category) VALUES (?, ?, ?)').run(owner, JSON.stringify(names), schedule);
  addCategories('alice', ['自定义分类', '课程', '日程与课表', '其他通知'], '日程与课表');
  addCategories('renamed', ['我的安排', '日程与课表', '其他通知'], '我的安排');
  addCategories('deleted', ['其他通知'], '其他通知');
  const add = (owner, id, patch = {}) => {
    const raw = { ...event(), category: '日程与课表', favorite: false, id, version: 1, revision: 1, createdAt: 1, updatedAt: 1, ...patch };
    legacy.prepare('INSERT INTO notice_events VALUES (?, ?, ?, ?, ?, ?, ?)').run(owner, id, `fixture-${id}`, JSON.stringify(raw), 1, 1, 1);
  };
  add('alice', 'source-course', { sourceName: '本学期课表截图', recurrence: { until: '2026-12-31', weekdays: [1], intervalWeeks: 1, weeks: [], excludeDates: [] } });
  add('alice', 'moved-course', { seriesId: 'source-course', originalDate: '2026-09-07' });
  add('alice', 'weekly-fitness', { title: '健身', recurrence: { until: '2026-12-31', weekdays: [2], intervalWeeks: 1, weeks: [], excludeDates: [] } });
  add('alice', 'uncertain-math', { title: '高等数学' });
  add('alice', 'custom-course', { sourceText: '课程表转写：周三第一节。', category: '自定义分类' });
  add('alice', 'old-unlinked-replacement', { sourceName: '手动调整' });
  add('renamed', 'renamed-course', { sourceName: '教务课表', category: '我的安排' });
  add('renamed', 'explicit-mixed-category', { category: '日程与课表' });
  add('deleted', 'deleted-course', { sourceName: '课表', category: '其他通知' });
  add('unopened', 'unopened-course', { sourceName: '课表' });
  legacy.close();
  let database = openDatabase(filename);
  try {
    let store = createEventStore(database.sqlite), categories = createCategoryStore(database.sqlite);
    const records = new Map(store.list('alice').map(value => [value.id, value]));
    assert.equal(records.get('source-course').recordType, 'course'); assert.equal(records.get('source-course').category, '课程');
    assert.equal(records.get('moved-course').recordType, 'course'); assert.equal(records.get('moved-course').category, '课程');
    assert.equal(records.get('weekly-fitness').recordType, 'schedule'); assert.equal(records.get('weekly-fitness').category, '日程');
    assert.equal(records.get('uncertain-math').recordType, 'schedule');
    assert.equal(records.get('custom-course').category, '自定义分类'); assert.equal(records.get('custom-course').sourceText, '课程表转写：周三第一节。');
    assert.equal(records.get('old-unlinked-replacement').recordType, 'schedule'); assert.equal(records.get('old-unlinked-replacement').seriesId, undefined);
    assert.deepEqual(store.list('renamed').map(value => value.category), ['日程与课表', '我的安排']);
    assert.equal(store.list('deleted')[0].category, '其他通知');
    assert.equal(categories.defaultCategory('deleted'), '其他通知');
    assert.equal(store.list('unopened')[0].category, '课程');
    assert.equal(categories.list('alice').filter(value => value === '课程').length, 1);
    assert.ok(!categories.list('alice').includes('日程与课表'));
    assert.equal(database.sqlite.prepare('SELECT fingerprint FROM notice_events WHERE owner_id = ? AND id = ?').get('alice', 'source-course').fingerprint, 'fixture-source-course');
    categories.change('alice', 'DELETE', { name: '课程' });
    database.close(); database = openDatabase(filename);
    store = createEventStore(database.sqlite); categories = createCategoryStore(database.sqlite);
    assert.ok(!categories.list('alice').includes('课程'));
    assert.equal(store.import('alice', [event({ title: '删除后重启的课程', recordType: 'course' })]).created[0].category, '其他通知');
    assert.equal(store.import('deleted', [event({ title: '删除旧分类后新日程' })]).created[0].category, '其他通知');
  } finally {
    database.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-course-type-migration-')) rmSync(directory, { recursive: true, force: true });
  }
});
