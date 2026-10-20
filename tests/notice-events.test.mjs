import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { normalizeEvents, normalizeNotice } from '../lib/notice-input.ts';
import { createApplication } from '../standalone/server.mjs';

const event = (patch = {}) => ({ title: '现场展示', date: '2026-10-25', ...patch });
const notice = (patch = {}) => ({ title: '测试竞赛通知', content: '原文：10月25日现场展示，10月24日18:00报名截止。', ...patch });
const normalizedEvent = (patch = {}) => ({ title: '现场展示', date: '2026-10-25', time: '', endDate: '', endTime: '', kind: 'event', evidence: '', ...patch });

test('安排规范化保留明示日期时间，兼容空数组、全天和跨日范围', () => {
  assert.deepEqual(normalizeNotice(notice()).events, []);
  assert.deepEqual(normalizeEvents([]), []);
  assert.deepEqual(normalizeEvents([event()]), [normalizedEvent()]);
  assert.deepEqual(normalizeEvents([event({ title: '  现场展示  ', evidence: ' 10月25日现场展示。 ' })]), [normalizedEvent({ evidence: '10月25日现场展示。' })]);
  const variants = [
    { time: '00:00', endTime: '00:01' },
    { time: '23:30', endDate: '2026-10-26', endTime: '00:10' },
    { endDate: '2026-10-27' },
    { endDate: '2026-10-25' },
    { time: '15:00', endDate: '2026-10-26' },
    { kind: 'deadline', time: '18:00' },
    { kind: 'deadline' },
    { date: '2028-02-29' },
    { title: '甲'.repeat(120), evidence: '乙'.repeat(500) },
    { date: '', evidence: '日期待通知，暂存依据。' },
  ];
  for (const patch of variants) assert.deepEqual(normalizeEvents([event(patch)]), [normalizedEvent(patch)]);
  assert.equal(normalizeEvents(Array.from({ length: 50 }, () => event())).length, 50);
});

test('安排拒绝非法结构、日期、时间、范围和超限内容', () => {
  for (const events of [null, {}, '安排', [null], [1], [[]], Array.from({ length: 51 }, () => event())]) assert.throws(() => normalizeEvents(events));
  const invalid = [
    { title: '' }, { title: '   ' }, { title: 12 }, { title: '甲'.repeat(121) },
    { date: '', time: '09:00' }, { date: '', endDate: '2026-10-25' }, { date: '', recurrence: { until: '2026-11-02', weekdays: [1] } }, { date: '2026-02-29' }, { date: '2026-04-31' }, { date: '2026-1-01' }, { date: null },
    { time: '24:00' }, { time: '09:60' }, { time: '9:00' }, { time: null },
    { endDate: '2026-02-30' }, { endDate: '2026-10-24' }, { endDate: 0 },
    { endTime: '18:00' }, { time: '18:00', endTime: '18:00' }, { time: '18:00', endTime: '17:59' },
    { time: '18:00', endTime: '24:00' }, { endTime: null },
    { kind: 'deadline', endDate: '2026-10-26' }, { kind: 'deadline', time: '17:00', endTime: '18:00' },
    { kind: 'other' }, { kind: '' }, { kind: null }, { evidence: 1 }, { evidence: '甲'.repeat(501) },
  ];
  for (const patch of invalid) assert.throws(() => normalizeEvents([event(patch)]), JSON.stringify(patch));
});

async function fixture(databaseFile) {
  let app;
  const server = createServer((request, response) => app.handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ databaseFile, origin });
  return {
    app,
    async call(path, { method = 'GET', body, cookie, token } = {}) {
      const response = await fetch(origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
      return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.json() };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); },
  };
}

test('结构化安排通过 HTTP/MCP 读写、兼容旧通知并持久化隔离', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-events-test-'));
  const databaseFile = join(directory, 'test.sqlite');
  let site = await fixture(databaseFile);
  try {
    const register = email => site.call('/api/auth/register', { method: 'POST', body: { email, password: 'Events-fixture-password-2026' } });
    const alice = await register('events-alice@example.test'), bob = await register('events-bob@example.test');
    const makeKey = cookie => site.call('/api/agent-keys', { method: 'POST', cookie, body: { name: '测试安排', permission: 'read_import' } });
    const key = (await makeKey(alice.cookie)).body, bobKey = (await makeKey(bob.cookie)).body;
    const rpc = (token, method, params = {}) => site.call('/mcp', { method: 'POST', token, body: { jsonrpc: '2.0', id: 1, method, params } });
    const tool = (token, name, args) => rpc(token, 'tools/call', { name, arguments: args });
    const initial = [event({ time: '09:00', endDate: '2026-10-26', endTime: '11:00', evidence: '10月25日9时至26日11时展示。' }), event({ title: '报名截止', date: '2026-10-24', time: '18:00', kind: 'deadline' })];
    const expected = initial.map(item => normalizedEvent(item));
    let id, mcpId, legacyId;

    await t.test('MCP schema 声明安排，HTTP Agent 导入后列表摘要和详情均返回安排', async () => {
      const schema = (await rpc(key.token, 'tools/list')).body.result.tools.find(item => item.name === 'import_notices').inputSchema.properties.notices.items.properties.events;
      assert.equal(schema.maxItems, 50); assert.deepEqual(schema.items.required, ['title', 'date']);
      const result = await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: [notice({ events: initial })] } });
      assert.equal(result.status, 200); assert.equal(result.body.imported, 1); id = result.body.created[0].id;
      const listed = (await tool(key.token, 'list_notices', {})).body.result.structuredContent.notices[0];
      assert.deepEqual(listed.events, expected); assert.equal(Object.hasOwn(listed, 'content'), false);
      assert.deepEqual((await site.call('/api/agent/notices', { token: key.token })).body.notices[0].events, expected);
      assert.deepEqual((await tool(key.token, 'get_notice', { id })).body.result.structuredContent.notice.events, expected);
      assert.deepEqual((await site.call(`/api/agent/notices/${id}`, { token: key.token })).body.notice.events, expected);
    });

    await t.test('MCP 导入安排；非法批次整批拒绝；同内容重复导入不覆盖安排', async () => {
      const result = (await tool(key.token, 'import_notices', { notices: [notice({ title: 'MCP 安排通知', events: [event()] })] })).body.result;
      assert.equal(result.isError, false); mcpId = result.structuredContent.created[0].id;
      assert.deepEqual((await tool(key.token, 'get_notice', { id: mcpId })).body.result.structuredContent.notice.events, [normalizedEvent()]);
      const repeat = await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: [notice({ events: [event({ time: '13:00' })] })] } });
      assert.equal(repeat.body.skipped, 1); assert.equal(repeat.body.duplicates[0].id, id);
      assert.deepEqual((await tool(key.token, 'get_notice', { id })).body.result.structuredContent.notice.events, expected);
      const invalid = [notice({ title: '不应写入', events: [] }), notice({ title: '无效安排', events: [event({ date: '2026-02-30' })] })];
      assert.equal((await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: invalid } })).status, 400);
      assert.equal((await tool(key.token, 'import_notices', { notices: invalid })).body.result.isError, true);
      assert.equal((await site.call('/api/notices', { cookie: alice.cookie })).body.notices.length, 2);
    });

    await t.test('面板 PATCH 保存安排，普通字段更新保留安排，显式空数组清除安排', async () => {
      const patch = changes => site.call('/api/notices', { method: 'PATCH', cookie: alice.cookie, body: { id, patch: changes } });
      assert.deepEqual((await patch({ favorite: true })).body.notice.events, expected);
      assert.equal((await patch({ events: [event({ endTime: '11:00' })] })).status, 400);
      const changed = [normalizedEvent({ date: '2026-10-28', endDate: '2026-10-30' })];
      assert.deepEqual((await patch({ events: changed })).body.notice.events, changed);
      assert.deepEqual((await patch({ read: true })).body.notice.events, changed);
      assert.deepEqual((await patch({ events: [] })).body.notice.events, []);
      assert.deepEqual((await patch({ events: initial })).body.notice.events, expected);
    });

    await t.test('旧通知缺少 events 时所有读取入口返回空数组，普通修改可保存', async () => {
      const saved = await site.call('/api/notices', { method: 'POST', cookie: alice.cookie, body: { notices: [notice({ title: '旧格式通知' })] } });
      legacyId = saved.body.created[0].id;
      assert.deepEqual(saved.body.created[0].events, []);
      site.app.database.sqlite.prepare("UPDATE notices SET data = json_remove(data, '$.events') WHERE id = ?").run(legacyId);
      assert.deepEqual((await site.call('/api/notices', { cookie: alice.cookie })).body.notices.find(item => item.id === legacyId).events, []);
      assert.deepEqual((await tool(key.token, 'list_notices', { query: '旧格式' })).body.result.structuredContent.notices[0].events, []);
      assert.deepEqual((await tool(key.token, 'get_notice', { id: legacyId })).body.result.structuredContent.notice.events, []);
      assert.deepEqual((await site.call('/api/notices', { method: 'PATCH', cookie: alice.cookie, body: { id: legacyId, patch: { favorite: true } } })).body.notice.events, []);
    });

    await t.test('账号隔离阻止跨账号读取和编辑安排，相同通知可各自保存', async () => {
      assert.deepEqual((await site.call('/api/agent/notices', { token: bobKey.token })).body.notices, []);
      assert.equal((await site.call(`/api/agent/notices/${id}`, { token: bobKey.token })).status, 404);
      assert.equal((await tool(bobKey.token, 'get_notice', { id })).body.result.isError, true);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', cookie: bob.cookie, body: { id, patch: { events: [] } } })).status, 404);
      assert.equal((await site.call('/api/agent/notices', { method: 'POST', token: bobKey.token, body: { notices: [notice({ events: [] })] } })).body.imported, 1);
      assert.deepEqual((await tool(key.token, 'get_notice', { id })).body.result.structuredContent.notice.events, expected);
    });

    await t.test('重启仍保留安排与旧格式空数组', async () => {
      await site.close(); site = await fixture(databaseFile);
      assert.deepEqual((await site.call(`/api/agent/notices/${id}`, { token: key.token })).body.notice.events, expected);
      const listed = (await site.call('/api/notices', { cookie: alice.cookie })).body.notices;
      assert.equal(listed.length, 3);
      assert.deepEqual(listed.find(item => item.id === legacyId).events, []);
      assert.deepEqual(listed.find(item => item.id === mcpId).events, [normalizedEvent()]);
    });

    await t.test('统一事件可只填标题，MCP保存周期课程及参与状态，修改时间后去重仍准确', async () => {
      const manageKey = (await site.call('/api/agent-keys', { method: 'POST', cookie: alice.cookie, body: { name: '统一事件测试', permission: 'manage' } })).body;
      const tools = (await rpc(manageKey.token, 'tools/list')).body.result.tools;
      const schema = tools.find(item => item.name === 'import_notices').inputSchema.properties.notices.items;
      assert.deepEqual(schema.required, ['title']); assert.deepEqual(schema.properties.participation.enum, ['reference', 'planned']);
      assert.ok(schema.properties.events.items.properties.recurrence);
      assert.ok(tools.find(item => item.name === 'update_event').inputSchema.properties.patch.properties.sourceUrl);
      const blankId = (await tool(manageKey.token, 'import_notices', { notices: [{ title: '还未定时间的事情' }] })).body.result.structuredContent.created[0].id;
      const blank = (await tool(manageKey.token, 'get_notice', { id: blankId })).body.result.structuredContent.notice;
      assert.equal(blank.content, ''); assert.deepEqual(blank.events, []); assert.equal(blank.participation, 'reference');
      const undatedInput = { title: '待定面试', events: [{ title: '面试时间待定', date: '', evidence: '具体日期另行通知。' }] };
      const undatedId = (await tool(manageKey.token, 'import_notices', { notices: [undatedInput] })).body.result.structuredContent.created[0].id;
      const undated = (await tool(manageKey.token, 'get_notice', { id: undatedId })).body.result.structuredContent.notice;
      assert.equal(undated.events[0].date, ''); assert.equal(undated.events[0].evidence, undatedInput.events[0].evidence);
      const input = { title: '写作讨论课', recordType: 'course', participation: 'planned', category: '课程', events: [{ title: '写作讨论课', date: '2026-10-19', recurrence: { until: '2026-11-02', weekdays: [1], excludeDates: ['2026-10-26'] }, evidence: '隔周讨论' }] };
      const result = (await tool(manageKey.token, 'import_notices', { notices: [input] })).body.result;
      assert.equal(result.isError, false); const course = (await tool(manageKey.token, 'get_notice', { id: result.structuredContent.created[0].id })).body.result.structuredContent.notice;
      assert.equal(course.recordType, 'course'); assert.equal(course.participation, 'planned'); assert.equal(course.active, true);
      const range = { from: '2026-10-19', to: '2026-11-02', recordType: 'course', type: 'recurring' };
      const schedule = (await tool(key.token, 'list_events', range)).body.result.structuredContent;
      assert.deepEqual(schedule.events.map(value => value.date), ['2026-10-19', '2026-11-02']);
      assert.ok(schedule.events.every(value => value.noticeId === course.id && value.occupiesTime && value.participation === 'planned'));
      assert.deepEqual((await tool(bobKey.token, 'list_events', range)).body.result.structuredContent.events, []);
      for (const patch of [{ participation: 'yes' }, { recordType: 'recurring' }, { active: 'false' }]) assert.equal((await site.call('/api/notices', { method: 'PATCH', cookie: alice.cookie, body: { id: course.id, patch } })).status, 400);
      const current = (await tool(manageKey.token, 'get_notice', { id: course.id })).body.result.structuredContent;
      const changedEvents = [{ ...input.events[0], date: '2026-10-20', recurrence: null }];
      const changed = (await tool(manageKey.token, 'update_notice_events', { id: course.id, expectedUpdatedAt: current.updatedAt, events: changedEvents })).body.result;
      assert.equal(changed.isError, false); assert.equal(changed.structuredContent.notice.id, course.id);
      const reimport = (await tool(manageKey.token, 'import_notices', { notices: [{ ...input, events: changedEvents }] })).body.result.structuredContent;
      assert.equal(reimport.skipped, 1); assert.equal(reimport.duplicates[0].id, course.id);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', cookie: alice.cookie, body: { id: course.id, patch: { active: false } } })).status, 200);
      assert.deepEqual((await tool(key.token, 'list_events', { ...range, type: 'all' })).body.result.structuredContent.events, []);
      const opened = (await site.call('/api/notices', { cookie: alice.cookie })).body.notices.find(value => value.id === id);
      assert.ok(Number.isSafeInteger(opened.updatedAt));
      const agentChange = (await tool(manageKey.token, 'update_notice_events', { id, expectedUpdatedAt: opened.updatedAt, events: [event({ date: '2026-11-03' })] })).body.result;
      assert.equal(agentChange.isError, false);
      const staleSave = await site.call('/api/notices', { method: 'PATCH', cookie: alice.cookie, body: { id, expectedUpdatedAt: opened.updatedAt, patch: { title: '过期表单', events: opened.events } } });
      assert.equal(staleSave.status, 409);
      const latest = (await site.call('/api/notices', { cookie: alice.cookie })).body.notices.find(value => value.id === id);
      assert.equal(latest.events[0].date, '2026-11-03'); assert.equal(latest.title, opened.title);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', cookie: alice.cookie, body: { id, expectedUpdatedAt: latest.updatedAt, patch: { title: '已刷新表单' } } })).status, 200);
    });
  } finally {
    await site.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-events-test-')) rmSync(directory, { recursive: true, force: true });
  }
});
