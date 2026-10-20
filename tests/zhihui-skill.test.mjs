import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderTimeline } from '../skills/zhihui-notices/scripts/render-timeline.mjs';
import { createApplication } from '../standalone/server.mjs';
import { createAuth } from '../standalone/auth.mjs';

const report = () => ({ title: '测试时间轴', today: '2026-10-18', timeZone: 'Asia/Shanghai', from: '2026-10-18', to: '2026-10-24', coverage: '自编测试数据，已读取全部原文。', events: [], undated: [] });
const event = (changes = {}) => ({ date: '2026-10-20', time: '', kind: '活动开始', title: '讲座', noticeId: 'fixture-id', evidence: '原文明确写明2026年10月20日举行讲座。', ...changes });

test('时间轴按日期和时分排序，日期类型及原文凭证不丢失，恶意内容不能变成 HTML', () => {
  const input = report();
  input.events = [event({ date: '2026-10-23', kind: '报名截止', title: '截止节点' }), event({ title: '当天时间未注明' }), event({ time: '14:00', title: '<script>bad()</script>', sourceUrl: 'javascript:bad()' })];
  input.undated = [{ title: '<img src=x onerror=bad()>', noticeId: 'unknown', reason: '下周，缺少发布时间。' }];
  const html = renderTimeline(input);
  assert.ok(html.indexOf('&lt;script&gt;') < html.indexOf('当天时间未注明'));
  assert.ok(html.indexOf('当天时间未注明') < html.indexOf('截止节点'));
  assert.ok(!html.includes('<script>')); assert.ok(!html.includes('<img src=x')); assert.ok(!html.includes('href="javascript:'));
  assert.ok(html.includes('时间未注明')); assert.ok(html.includes('报名截止')); assert.ok(html.includes('fixture-id')); assert.ok(html.includes('日期依据'));
  assert.ok(html.includes('是否落在本次日期范围，尚待确认')); assert.ok(html.includes("default-src 'none'"));
});

test('拒绝无效日期、无依据节点、窗口外日期与虚构时分格式', () => {
  for (const invalid of [{ date: '2026-02-30' }, { date: '2026-10-25' }, { time: '24:00' }, { evidence: '' }, { noticeId: '' }]) {
    assert.throws(() => renderTimeline({ ...report(), events: [event(invalid)] }));
  }
  assert.throws(() => renderTimeline({ ...report(), from: '2026-10-25' }));
  assert.throws(() => renderTimeline({ ...report(), coverage: '' }));
});

test('活动区间保留真实起止，跨窗口只展示一次且不补造时分', () => {
  const input = { ...report(), events: [
    event({ kind: 'event', title: '跨周展览', date: '2026-10-17', endDate: '2026-10-21' }),
    event({ kind: 'event', title: '定时讲座', time: '14:00', endTime: '16:00' }),
    event({ kind: 'event', title: '结束时分未知', time: '18:00', endDate: '2026-10-20' }),
    event({ kind: 'deadline', title: '申请截止', date: '2026-10-24' }),
  ] };
  const before = JSON.stringify(input);
  const html = renderTimeline(input);
  assert.ok(html.includes('进行中 · 活动'));
  assert.ok(html.includes('2026-10-17 时间未注明 — 2026-10-21 时间未注明'));
  assert.ok(html.includes('14:00 — 16:00'));
  assert.ok(html.includes('18:00 — 结束时间未注明'));
  assert.ok(!html.includes('00:00'));
  assert.equal(html.split('<h2>跨周展览</h2>').length - 1, 1);
  assert.ok(html.includes('class="event deadline"'));
  assert.equal(JSON.stringify(input), before);
});

test('区间需有效、有交集；截止事项不能伪装为持续活动', () => {
  for (const invalid of [
    { endDate: '2026-02-30' }, { endDate: '2026-10-19' },
    { endTime: '16:00' }, { time: '14:00', endTime: '24:00' },
    { time: '14:00', endTime: '14:00' }, { time: '14:00', endTime: '13:00' },
    { kind: 'deadline', endDate: '2026-10-21' },
    { kind: '报名截止', time: '14:00', endTime: '16:00' },
    { date: '2026-10-16', endDate: '2026-10-17' },
  ]) assert.throws(() => renderTimeline({ ...report(), events: [event(invalid)] }));
  const html = renderTimeline({ ...report(), events: [event({ date: '2026-10-17', endDate: '2026-10-18' })] });
  assert.ok(html.includes('进行中'));
  assert.ok(html.includes('2026-10-17 时间未注明 — 2026-10-18 时间未注明'));
});

test('空结果和时间待确认可以单独展示，不生成假的日程', () => {
  const html = renderTimeline({ ...report(), undated: [{ title: '待定活动', noticeId: 'pending', reason: '尚未公布日期。' }] });
  assert.ok(html.includes('没有该范围内时间明确的安排')); assert.ok(html.includes('待定活动'));
  assert.ok(!html.includes('<section class="day">'));
});

test('个人日程和任务使用真实来源编号，保留依据且兼容关联通知', () => {
  const input = { ...report(), events: [
    event({ noticeId: undefined, title: '高等数学', reference: { type: 'event', id: 'course-1' }, evidence: '用户课表：周二第3—4节；已确认节次映射为10:00—11:35。', time: '10:00', endTime: '11:35' }),
    event({ noticeId: '', title: '完成实验报告', reference: { type: 'task', id: '<task-1>' }, evidence: '任务记录的计划日期为2026-10-20，预计用时60分钟。' }),
    event({ title: '有通知来源的任务', reference: { type: 'task', id: 'task-2' } }),
  ], undated: [{ title: '尚待排期的任务', reference: { type: 'task', id: 'task-3' }, reason: '用户尚未提供具体计划日期。' }] };
  const before = JSON.stringify(input);
  const html = renderTimeline(input);
  assert.ok(html.includes('日程编号：course-1'));
  assert.ok(html.includes('任务编号：&lt;task-1&gt;'));
  assert.ok(html.includes('任务编号：task-3'));
  assert.ok(html.includes('事件编号：fixture-id'));
  assert.ok(html.includes('周二第3—4节'));
  assert.ok(!html.includes('事件编号：undefined'));
  assert.ok(!html.includes('<task-1>'));
  assert.equal(JSON.stringify(input), before);
});

test('个人日程仍必须保留可追溯编号与时间依据，不接受伪造来源类型', () => {
  for (const reference of [null, {}, { type: 'notice', id: 'fake' }, { type: 'task', id: '' }, { type: 'event', id: 1 }]) {
    assert.throws(() => renderTimeline({ ...report(), events: [event({ noticeId: undefined, reference })] }));
  }
  assert.throws(() => renderTimeline({ ...report(), events: [event({ noticeId: undefined, reference: { type: 'event', id: 'course-1' }, evidence: '' })] }));
  assert.throws(() => renderTimeline({ ...report(), undated: [{ title: '未排期', reason: '尚无日期。' }] }));
});

test('CLI 在中文空格目录输出可打开的 HTML，错误数据不会写入结果', () => {
  const directory = mkdtempSync(join(tmpdir(), '知会 时间轴-'));
  try {
    const input = join(directory, '输入.json'), output = join(directory, '时间轴.html');
    // 使用内联 Node 写输入，避免依赖平台 shell 编码。
    const source = `require('node:fs').writeFileSync(process.argv[1], process.argv[2])`;
    assert.equal(spawnSync(process.execPath, ['-e', source, input, JSON.stringify(report())]).status, 0);
    const script = resolve('skills/zhihui-notices/scripts/render-timeline.mjs');
    assert.equal(spawnSync(process.execPath, [script, input, output], { encoding: 'utf8' }).status, 0);
    assert.ok(readFileSync(output, 'utf8').startsWith('<!doctype html>'));
    const failed = join(directory, '不应创建.html');
    assert.equal(spawnSync(process.execPath, [script, '不存在.json', failed]).status, 1);
    assert.equal(existsSync(failed), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('隔离账号通过 MCP 导入、分页、读取原文和生成时间轴；skill 下载为真实 ZIP', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-skill-test-'));
  let app;
  const server = createServer((request, response) => app.handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ databaseFile: join(directory, 'test.sqlite'), origin });
  try {
    const auth = createAuth(app.database.sqlite);
    const { user } = await auth.register({ email: 'skill@example.test', password: 'Fixture-skill-password-2026' }, 'fixture', new Headers());
    const key = auth.createKey(user.id, '测试读写', 'read_import');
    const call = async (name, args) => {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
      const rpc = await response.json(); assert.equal(rpc.result.isError, false); return rpc.result.structuredContent;
    };
    const notices = [
      { title: '自编测试：讲座', content: '2026年10月20日14:00至16:00举行讲座，地点为报告厅。', category: '校园活动', deadline: '', events: [
        { title: '讲座', date: '2026-10-20', time: '14:00', endTime: '16:00', kind: 'event', evidence: '2026年10月20日14:00至16:00举行讲座' },
      ] },
      { title: '自编测试：报名', content: '2026年10月23日前报名，2026年10月24日10:00活动开始。', deadline: '2026-10-23', events: [
        { title: '报名截止', date: '2026-10-23', kind: 'deadline', evidence: '2026年10月23日前报名' },
        { title: '活动', date: '2026-10-24', time: '10:00', evidence: '2026年10月24日10:00活动开始' },
      ] },
    ];
    const imported = await call('import_notices', { notices });
    assert.equal(imported.imported, 2);
    const first = await call('list_notices', { limit: 1 });
    assert.equal(first.hasMore, true);
    const second = await call('list_notices', { limit: 1, offset: 1 });
    assert.equal(second.hasMore, false);
    assert.equal([...first.notices, ...second.notices].reduce((total, notice) => total + notice.events.length, 0), 3);
    const originals = await Promise.all([...first.notices, ...second.notices].map(n => call('get_notice', { id: n.id })));
    const lecture = originals.find(r => r.notice.title.includes('讲座')).notice;
    const signup = originals.find(r => r.notice.title.includes('报名')).notice;
    assert.equal(lecture.events[0].endTime, '16:00');
    assert.deepEqual(signup.events.map(item => item.kind), ['deadline', 'event']);
    const html = renderTimeline({ ...report(), events: [lecture, signup].flatMap(notice => notice.events.map(item => ({ ...item, noticeId: notice.id, sourceName: notice.sourceName }))) });
    assert.ok(html.includes(lecture.id)); assert.ok(html.includes(signup.id)); assert.ok(html.includes('10 / 24')); assert.ok(html.includes('14:00 — 16:00'));
    const duplicate = await call('import_notices', { notices: [{ ...notices[0], events: [] }] });
    assert.equal(duplicate.skipped, 1); assert.equal(duplicate.duplicates[0].id, lecture.id);
    assert.deepEqual((await call('get_notice', { id: lecture.id })).notice.events, lecture.events);
    const download = await fetch(`${origin}/agent-skill.zip`);
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/zip');
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('管理工作流保存课表偏好、按周次导入、仅调一次课、完成后重开任务并据记录复盘', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-planning-skill-'));
  let app;
  const server = createServer((request, response) => app.handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ databaseFile: join(directory, 'test.sqlite'), origin });
  try {
    const auth = createAuth(app.database.sqlite);
    const { user } = await auth.register({ email: 'planning-skill@example.test', password: 'Fixture-planning-password-2026' }, 'fixture', new Headers());
    const manager = auth.createKey(user.id, '时间管理', 'manage');
    const reader = auth.createKey(user.id, '原有读写', 'read_import');
    const rpc = async (token, method, params) => {
      const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const message = await response.json();
      return message.result ?? message;
    };
    const call = async (name, args) => {
      const result = await rpc(manager.token, 'tools/call', { name, arguments: args });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result.structuredContent;
    };
    const readTools = await rpc(reader.token, 'tools/list', {});
    assert.ok(readTools.tools.some(tool => tool.name === 'list_events'));
    assert.ok(readTools.tools.some(tool => tool.name === 'review_period'));
    assert.ok(!readTools.tools.some(tool => tool.name === 'create_task'));
    const denied = await rpc(reader.token, 'tools/call', { name: 'create_task', arguments: { task: { title: '不应保存' } } });
    assert.ok(denied.error || denied.isError);

    const preferences = await call('get_preferences', {});
    const saved = await call('update_preferences', { expectedVersion: preferences.version, patch: {
      semesterStart: '2026-10-19', semesterEnd: '2026-11-15', dailyCapacityMinutes: 90, bufferMinutes: 20,
      classPeriods: [{ period: 1, start: '08:00', end: '08:45' }, { period: 2, start: '08:50', end: '09:35' }],
    } });
    assert.equal((await call('get_preferences', {})).version, saved.version);
    const sourceText = '自编课表：高等数学，周一1—4周单周、周二1—4周双周，第1—2节，A201。';
    const course = { title: '高等数学', date: saved.semesterStart, time: saved.classPeriods[0].start, endTime: saved.classPeriods[1].end, sourceName: '用户课表截图', sourceText, notes: '学期第1周周一为2026-10-19，第1—2节08:00—09:35，保留原单双周。' };
    const imported = await call('import_events', { events: [
      { ...course, recurrence: { until: saved.semesterEnd, weekdays: [1], weeks: [1, 3] } },
      { ...course, recurrence: { until: saved.semesterEnd, weekdays: [2], weeks: [2, 4] } },
    ] });
    assert.equal(imported.imported, 2);
    assert.notEqual(imported.created[0].id, imported.created[1].id);
    const all = [];
    let page;
    do {
      page = await call('list_events', { from: saved.semesterStart, to: saved.semesterEnd, type: 'recurring', limit: 1, offset: all.length });
      all.push(...page.events);
    } while (page.hasMore);
    assert.deepEqual(all.map(item => item.date), ['2026-10-19', '2026-10-27', '2026-11-02', '2026-11-10']);
    const first = all[0];
    assert.equal(first.eventId, imported.created[0].id);
    const moved = await call('change_event_occurrence', { id: first.eventId, expectedVersion: first.version, occurrenceDate: first.occurrenceDate, changes: { date: '2026-10-21', time: '10:00', endTime: '11:35', location: 'A202' } });
    assert.equal(moved.created.recurrence, null);
    const after = await call('list_events', { from: saved.semesterStart, to: saved.semesterEnd, query: '高等数学' });
    assert.deepEqual(after.events.map(item => [item.date, item.time]), [['2026-10-21', '10:00'], ['2026-10-27', '08:00'], ['2026-11-02', '08:00'], ['2026-11-10', '08:00']]);

    const noticeInput = { title: '自编：讲座日期更正', content: '报名10月22日截止。原定2026年10月23日14:00的讲座，更正为2026年10月24日14:00。', events: [
      { title: '报名截止', date: '2026-10-22', kind: 'deadline', evidence: '报名10月22日截止。' },
      { title: '讲座', date: '2026-10-23', time: '14:00', kind: 'event', evidence: '原定2026年10月23日14:00的讲座。' },
    ] };
    const noticeId = (await call('import_notices', { notices: [noticeInput] })).created[0].id;
    const original = await call('get_notice', { id: noticeId });
    await call('update_notice_events', { id: noticeId, expectedUpdatedAt: original.updatedAt, events: original.notice.events.map(item => item.kind === 'event' ? { ...item, date: '2026-10-24', evidence: '更正为2026年10月24日14:00。' } : item) });
    const corrected = await call('get_notice', { id: noticeId });
    assert.equal(corrected.notice.content, original.notice.content);
    assert.deepEqual(corrected.notice.events.map(item => item.date), ['2026-10-22', '2026-10-24']);

    const taskInput = { title: '完成实验报告', estimatedMinutes: 60, dueDate: '2026-10-23', plannedDate: '2026-10-21', plannedStartTime: '19:00', plannedEndTime: '20:00' };
    const created = await call('create_task', { task: taskInput });
    const duplicate = await call('create_task', { task: taskInput });
    assert.equal(duplicate.duplicate, true); assert.equal(duplicate.task.id, created.task.id);
    const completed = await call('update_task', { id: created.task.id, expectedVersion: created.task.version, patch: { status: 'done' } });
    assert.ok(completed.task.completedAt);
    const reopened = await call('update_task', { id: completed.task.id, expectedVersion: completed.task.version, patch: { status: 'todo', plannedDate: '2026-10-22' } });
    assert.equal(reopened.task.completedAt, null);
    const tasks = await call('list_tasks', { status: 'todo' });
    assert.equal(tasks.tasks.length, 1);
    const review = await call('review_period', { from: tasks.today, to: tasks.today });
    assert.ok(review.changes.some(change => change.after.status === 'done'));
    assert.ok(!review.completed.some(task => task.id === reopened.task.id));
    assert.ok(review.estimatedMinutesNote.includes('不代表实际'));

    const timeline = await call('list_events', { from: saved.semesterStart, to: saved.semesterEnd });
    const html = renderTimeline({ ...report(), today: timeline.today, from: saved.semesterStart, to: saved.semesterEnd, coverage: '隔离账号已录入的课表、任务及已核对原文的通知。', events: timeline.events.map(item => ({
      ...item,
      reference: item.sourceType === 'event' ? { type: 'event', id: item.eventId } : item.sourceType === 'task' ? { type: 'task', id: item.taskId } : undefined,
      evidence: item.evidence || `已保存${item.sourceType === 'task' ? '任务' : '日程'}时间：${item.date} ${item.time || '时间未注明'}；${item.sourceText || item.notes || ''}`,
    })) });
    assert.ok(html.includes(`日程编号：${first.eventId}`));
    assert.ok(html.includes(`任务编号：${created.task.id}`));
    assert.ok(html.includes(`事件编号：${noticeId}`));
    assert.ok(html.includes('10:00 — 11:35'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
