import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApplication } from '../standalone/server.mjs';
import { createAuth } from '../standalone/auth.mjs';

const readerTools = ['list_events', 'list_tasks', 'get_preferences', 'review_period'];
const writerTools = ['import_events', 'update_event', 'change_event_occurrence', 'update_notice_events', 'create_task', 'update_task', 'update_preferences'];
const range = { from: '2026-10-19', to: '2026-11-09' };
const suffix = new URLSearchParams(range).toString();

function removeFixture(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('zhihui-planner-'));
  rmSync(directory, { recursive: true, force: true });
}

async function fixture(databaseFile) {
  let app;
  const server = createServer((request, response) => app.handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ databaseFile, origin });
  const call = async (path, { method = 'GET', cookie, token, body } = {}) => {
    const response = await fetch(origin + path, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    app, call,
    rpc: (key, method, params) => call('/mcp', { method: 'POST', token: key.token, body: { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) } }),
    tool: (key, name, args = {}) => call('/mcp', { method: 'POST', token: key.token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }),
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); },
  };
}

function data(response) {
  assert.equal(response.status, 200);
  assert.equal(response.body.result?.isError, false, JSON.stringify(response.body));
  return response.body.result.structuredContent;
}

test('时间管理 HTTP/MCP 权限、任务课表修改、冲突与重启存续', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhihui-planner-api-'));
  const databaseFile = join(directory, 'test.sqlite');
  let site = await fixture(databaseFile);
  const auth = createAuth(site.app.database.sqlite);
  const alice = await auth.register({ email: 'planner-alice@example.test', password: 'Planner-alice-fixture-2026' }, 'planner-alice', new Headers());
  const bob = await auth.register({ email: 'planner-bob@example.test', password: 'Planner-bob-fixture-2026' }, 'planner-bob', new Headers());
  const aliceCookie = alice.cookie.split(';')[0], bobCookie = bob.cookie.split(';')[0];
  const keys = {};
  for (const permission of ['import', 'read', 'read_import', 'manage']) {
    const created = await site.call('/api/agent-keys', { method: 'POST', cookie: aliceCookie, body: { name: `测试-${permission}`, permission } });
    assert.equal(created.status, 200); keys[permission] = created.body;
  }
  const foreignKey = auth.createKey(bob.user.id, '其他账号管理', 'manage');
  let task, course, preferences, noticeId, noticeBefore, noticeAfter, courseVersion;
  const content = '测试通知原文：10月20日18:00提交材料。保留这段内容，不随日程调整而改写。';
  try {
    await t.test('发现工具严格对应四种权限，manage 保留旧接口且显式扩权', async () => {
      const names = async key => (await site.rpc(key, 'tools/list')).body.result.tools.map(tool => tool.name);
      assert.deepEqual(await names(keys.import), ['import_notices']);
      assert.deepEqual(await names(keys.read), ['list_notices', 'get_notice', ...readerTools]);
      assert.deepEqual(await names(keys.read_import), ['import_notices', 'list_notices', 'get_notice', ...readerTools]);
      assert.deepEqual((await names(keys.manage)).sort(), ['import_notices', 'list_notices', 'get_notice', ...readerTools, ...writerTools].sort());
      assert.equal((await names(keys.manage)).length, 14);
      assert.equal((await site.rpc(keys.manage, 'initialize')).body.result.serverInfo.version, '3.0.0');
      const rows = site.app.database.sqlite.prepare('SELECT id, permission, planner_access FROM agent_keys WHERE user_id = ?').all(alice.user.id);
      assert.deepEqual({ ...rows.find(row => row.id === keys.manage.id) }, { id: keys.manage.id, permission: 'read_import', planner_access: 1 });
      for (const permission of ['import', 'read', 'read_import']) assert.equal(rows.find(row => row.id === keys[permission].id).planner_access, 0);
      const listed = (await site.call('/api/agent-keys', { cookie: aliceCookie })).body.keys;
      assert.equal(listed.find(key => key.id === keys.manage.id).permission, 'manage');
    });

    await t.test('旧导入密钥不能读时间表，read/read_import 可读但均不能修改', async () => {
      assert.equal((await site.call('/api/tasks')).status, 401);
      assert.equal((await site.call('/api/agent/tasks')).status, 401);
      const reads = [['/api/agent/events?' + suffix, 'list_events', range], ['/api/agent/tasks', 'list_tasks', {}], ['/api/agent/preferences', 'get_preferences', {}], ['/api/agent/review?' + suffix, 'review_period', range]];
      for (const [path, name, args] of reads) {
        assert.equal((await site.call(path, { token: keys.import.token })).status, 403);
        assert.equal((await site.tool(keys.import, name, args)).body.error.code, -32602);
        for (const permission of ['read', 'read_import']) {
          assert.equal((await site.call(path, { token: keys[permission].token })).status, 200);
          data(await site.tool(keys[permission], name, args));
        }
      }
      const writes = [
        ['/api/agent/tasks', 'POST', { task: { title: '无权新建' } }],
        ['/api/agent/tasks', 'PATCH', { id: 'unknown', patch: { status: 'done' }, expectedVersion: 1 }],
        ['/api/agent/events', 'POST', { events: [{ title: '无权导课表', date: '2026-10-19', recordType: 'course' }] }],
        ['/api/agent/events', 'PATCH', { id: 'unknown', patch: { title: '无权修改', recordType: 'course' }, expectedVersion: 1 }],
        ['/api/agent/event-occurrence', 'PATCH', { id: 'unknown', occurrenceDate: '2026-10-19', changes: null, expectedVersion: 1 }],
        ['/api/agent/preferences', 'PATCH', { patch: { notes: '无权保存' }, expectedVersion: 0 }],
      ];
      for (const permission of ['import', 'read', 'read_import']) {
        for (const [path, method, body] of writes) assert.equal((await site.call(path, { method, body, token: keys[permission].token })).status, 403);
        for (const name of writerTools) assert.equal((await site.tool(keys[permission], name, {})).body.error.code, -32602);
      }
      assert.equal((await site.call('/api/tasks', { token: keys.manage.token })).status, 401);
      assert.deepEqual((await site.call('/api/tasks', { cookie: aliceCookie })).body.tasks, []);
    });

    await t.test('manage 可创建关联任务、记录完成与偏好，过期版本返回409', async () => {
      const imported = data(await site.tool(keys.manage, 'import_notices', { notices: [{ title: '材料提交测试', content, sourceName: '测试教务处', publishedAt: '2026-10-18', events: [{ title: '提交材料', date: '2026-10-20', time: '18:00', kind: 'deadline', evidence: '10月20日18:00提交材料。' }] }] }));
      noticeId = imported.created[0].id;
      noticeBefore = data(await site.tool(keys.manage, 'get_notice', { id: noticeId }));
      assert.equal(data(await site.tool(keys.manage, 'list_notices', { query: '材料提交测试' })).total, 1);
      task = data(await site.tool(keys.manage, 'create_task', { task: { title: '准备材料', notes: '用户明确要完成', noticeId, plannedDate: '2026-10-20', plannedStartTime: '10:00', plannedEndTime: '10:30', dueDate: '2026-10-21', estimatedMinutes: 30 } })).task;
      const duplicate = data(await site.tool(keys.manage, 'create_task', { task: { title: '准备材料', noticeId, notes: '不能覆盖' } }));
      assert.equal(duplicate.duplicate, true); assert.deepEqual(duplicate.task, task);
      const started = await site.call('/api/agent/tasks', { method: 'PATCH', token: keys.manage.token, body: { id: task.id, patch: { status: 'in_progress' }, expectedVersion: task.version } });
      assert.equal(started.status, 200); task = started.body.task;
      task = data(await site.tool(keys.manage, 'update_task', { id: task.id, patch: { status: 'done' }, expectedVersion: task.version })).task;
      assert.equal(task.status, 'done'); assert.equal(typeof task.completedAt, 'number');
      assert.equal((await site.call('/api/agent/tasks', { method: 'PATCH', token: keys.manage.token, body: { id: task.id, patch: { status: 'todo' }, expectedVersion: 1 } })).status, 409);
      preferences = data(await site.tool(keys.manage, 'update_preferences', { expectedVersion: 0, patch: { dailyCapacityMinutes: 90, bufferMinutes: 20, notes: '周日晚复盘', semesterStart: '2026-09-02', semesterEnd: '2027-01-20', classPeriods: [{ period: 1, start: '08:00', end: '08:45' }] } }));
      assert.equal(preferences.version, 1); assert.equal(preferences.semesterStart, '2026-09-02');
      assert.equal((await site.call('/api/agent/preferences', { method: 'PATCH', token: keys.manage.token, body: { patch: { notes: '不能覆盖' }, expectedVersion: 0 } })).status, 409);
      assert.deepEqual(data(await site.tool(keys.read, 'list_tasks', { status: 'done' })).tasks, [task]);
      const today = data(await site.tool(keys.read_import, 'list_tasks')).today;
      const review = data(await site.tool(keys.manage, 'review_period', { from: today, to: today }));
      assert.equal(review.completed[0].id, task.id); assert.equal(review.changes.length, 3);
      assert.match(review.estimatedMinutesNote, /不代表实际工作量/);
    });

    await t.test('课表可去重导入、按范围展开、单次调课停课并保留其他周', async () => {
      const input = { title: '高等数学', recordType: 'course', date: '2026-10-19', time: '08:00', endTime: '08:45', location: '教一101', sourceName: '课表截图', sourceText: '截图转写：第1—4周周一第一节，高等数学，教一101。', recurrence: { until: '2026-11-09', weekdays: [1], weeks: [1, 2, 3, 4] } };
      const imported = data(await site.tool(keys.manage, 'import_events', { events: [input] }));
      assert.equal(imported.imported, 1); course = imported.created[0];
      assert.equal(course.category, '课程'); assert.equal(course.recordType, 'course'); assert.equal(course.favorite, false);
      assert.equal(data(await site.tool(keys.manage, 'import_events', { events: [input] })).skipped, 1);
      const invalidCategory = await site.call('/api/events', { method: 'POST', cookie: aliceCookie, body: { events: [{ ...input, title: '未知分类不可保存', category: '不存在的分类' }] } });
      assert.equal(invalidCategory.status, 400);
      assert.equal((await site.call('/api/events', { method: 'POST', cookie: aliceCookie, body: { events: [{ ...input, recordType: 'recurring' }] } })).status, 400);
      const combined = (await site.call('/api/notices', { cookie: aliceCookie })).body;
      assert.ok(combined.categories.includes('课程'));
      assert.equal(combined.scheduleCategory, '日程'); assert.equal(combined.courseCategory, '课程');
      assert.equal(combined.eventRules.length, 1); assert.equal(combined.eventRules[0].id, course.id);
      assert.equal(combined.eventRules[0].eventType, 'recurring');
      assert.ok(['upcoming', 'ongoing', 'ended'].includes(combined.eventRules[0].scheduleStatus));
      assert.deepEqual((await site.call('/api/notices', { cookie: bobCookie })).body.eventRules, []);
      const initial = data(await site.tool(keys.manage, 'list_events', { ...range, type: 'recurring' }));
      assert.deepEqual(initial.events.map(event => event.date), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09']);
      assert.deepEqual(data(await site.tool(keys.read, 'list_events', { ...range, recordType: 'course' })).events, initial.events);
      const personalEvents = data(await site.tool(keys.read, 'list_events', { ...range, recordType: 'schedule' })).events;
      assert.equal(personalEvents.length, 1); assert.equal(personalEvents[0].noticeId, noticeId);
      assert.equal(personalEvents[0].participation, 'reference'); assert.equal(personalEvents[0].occupiesTime, false);
      const page = await site.call('/api/agent/events?' + suffix + '&type=recurring&limit=1&offset=1', { token: keys.read.token });
      assert.equal(page.body.total, 4); assert.equal(page.body.events[0].date, '2026-10-26'); assert.equal(page.body.hasMore, true);
      const all = data(await site.tool(keys.manage, 'list_events', range));
      assert.ok(all.events.some(event => event.sourceType === 'notice' && event.noticeId === noticeId));
      assert.ok(all.events.some(event => event.sourceType === 'task' && event.taskId === task.id && event.occupiesTime === false));
      const moved = data(await site.tool(keys.manage, 'change_event_occurrence', { id: course.id, expectedVersion: course.version, occurrenceDate: '2026-10-26', changes: { date: '2026-10-27', time: '14:00', endTime: '14:45', location: '教二202' } }));
      assert.equal(moved.created.date, '2026-10-27'); assert.equal(moved.created.recurrence, null);
      assert.equal(moved.created.recordType, 'course');
      const cancelled = await site.call('/api/agent/event-occurrence', { method: 'PATCH', token: keys.manage.token, body: { id: course.id, expectedVersion: moved.event.version, occurrenceDate: '2026-11-02', changes: null } });
      assert.equal(cancelled.status, 200); assert.equal(cancelled.body.created, null);
      const updated = data(await site.tool(keys.manage, 'update_event', { id: course.id, expectedVersion: cancelled.body.event.version, patch: { notes: '按用户要求调整这门课程备注', category: '课程学习', favorite: true } }));
      courseVersion = updated.event.version;
      assert.equal(updated.event.category, '课程学习'); assert.equal(updated.event.favorite, true);
      const cards = (await site.call('/api/notices', { cookie: aliceCookie })).body.eventRules;
      assert.equal(cards.length, 1); assert.equal(cards[0].category, '课程学习'); assert.equal(cards[0].favorite, true);
      assert.equal((await site.call('/api/agent/events', { method: 'PATCH', token: keys.manage.token, body: { id: course.id, expectedVersion: 1, patch: { title: '不能覆盖' } } })).status, 409);
      const current = data(await site.tool(keys.manage, 'list_events', range));
      const classes = current.events.filter(event => event.sourceType === 'event');
      assert.deepEqual(classes.map(event => [event.date, event.time, event.location]), [['2026-10-19', '08:00', '教一101'], ['2026-10-27', '14:00', '教二202'], ['2026-11-09', '08:00', '教一101']]);
      assert.equal(classes[0].sourceText, input.sourceText);
    });

    await t.test('只更新通知安排并保留原文，旧 updatedAt 和额外正文参数被拒绝', async () => {
      const events = [{ title: '用户更正后的提交安排', date: '2026-10-22', time: '17:00', kind: 'deadline', evidence: '用户明确更正为10月22日17:00。' }];
      noticeAfter = data(await site.tool(keys.manage, 'update_notice_events', { id: noticeId, expectedUpdatedAt: noticeBefore.updatedAt, events }));
      assert.ok(noticeAfter.updatedAt > noticeBefore.updatedAt);
      assert.deepEqual(noticeAfter.notice.events, [{ ...events[0], endDate: '', endTime: '' }]);
      const before = { ...noticeBefore.notice }, after = { ...noticeAfter.notice };
      delete before.events; delete after.events;
      assert.deepEqual(after, before); assert.equal(after.content, content);
      const stale = await site.tool(keys.manage, 'update_notice_events', { id: noticeId, expectedUpdatedAt: noticeBefore.updatedAt, events: [] });
      assert.equal(stale.body.result.isError, true); assert.match(stale.body.result.content[0].text, /事件已变化/);
      const overwrite = await site.tool(keys.manage, 'update_notice_events', { id: noticeId, expectedUpdatedAt: noticeAfter.updatedAt, events: [], content: '禁止覆盖原文' });
      assert.equal(overwrite.body.result.isError, true);
      const detail = await site.call(`/api/agent/notices/${noticeId}`, { token: keys.read.token });
      assert.equal(detail.body.updatedAt, noticeAfter.updatedAt); assert.deepEqual(detail.body.notice, noticeAfter.notice);
      const listed = (await site.call('/api/notices', { cookie: aliceCookie })).body.notices.find(notice => notice.id === noticeId);
      assert.equal(listed.content, content); assert.equal(listed.events[0].date, '2026-10-22');
    });

    await t.test('跨账号编号和伪造 owner 不可读取或修改任务、课表和通知', async () => {
      assert.deepEqual(data(await site.tool(foreignKey, 'list_tasks')).tasks, []);
      assert.equal(data(await site.tool(foreignKey, 'get_preferences')).version, 0);
      assert.deepEqual(data(await site.tool(foreignKey, 'list_events', range)).events, []);
      assert.deepEqual(data(await site.tool(foreignKey, 'review_period', range)).changes, []);
      for (const [path, body] of [
        ['/api/agent/tasks', { id: task.id, expectedVersion: task.version, patch: { status: 'todo' } }],
        ['/api/agent/events', { id: course.id, expectedVersion: courseVersion, patch: { title: '越权修改' } }],
        ['/api/agent/event-occurrence', { id: course.id, expectedVersion: courseVersion, occurrenceDate: '2026-11-09', changes: null }],
      ]) assert.equal((await site.call(path, { method: 'PATCH', token: foreignKey.token, body })).status, 404);
      const foreignNotice = await site.tool(foreignKey, 'update_notice_events', { id: noticeId, expectedUpdatedAt: noticeAfter.updatedAt, events: [] });
      assert.equal(foreignNotice.body.result.isError, true); assert.match(foreignNotice.body.result.content[0].text, /不属于当前账号/);
      assert.equal((await site.call('/api/agent/tasks', { method: 'POST', token: foreignKey.token, body: { task: { title: '越权关联', noticeId } } })).status, 404);
      assert.equal((await site.call('/api/tasks', { method: 'PATCH', cookie: bobCookie, body: { id: task.id, expectedVersion: task.version, patch: { status: 'todo' } } })).status, 404);
      assert.equal((await site.call(`/api/agent/tasks?owner=${encodeURIComponent(alice.user.id)}`, { token: foreignKey.token })).status, 400);
      const injected = await site.tool(foreignKey, 'list_events', { ...range, owner: alice.user.id });
      assert.equal(injected.body.result.isError, true);
    });

    await t.test('重启保留权限、任务完成与历史、课表调停记录、偏好和通知安排', async () => {
      await site.close(); site = await fixture(databaseFile);
      assert.deepEqual(data(await site.tool(keys.read, 'list_tasks')).tasks, [task]);
      assert.deepEqual(data(await site.tool(keys.read, 'get_preferences')), preferences);
      const rules = await site.call('/api/agent/event-rules', { token: keys.read_import.token });
      const persisted = rules.body.events.find(event => event.id === course.id);
      assert.equal(persisted.version, courseVersion); assert.deepEqual(persisted.recurrence.excludeDates, ['2026-10-26', '2026-11-02']);
      const occurrences = data(await site.tool(keys.read_import, 'list_events', range)).events.filter(event => event.sourceType === 'event');
      assert.deepEqual(occurrences.map(event => event.date), ['2026-10-19', '2026-10-27', '2026-11-09']);
      const detail = data(await site.tool(keys.manage, 'get_notice', { id: noticeId }));
      assert.deepEqual(detail.notice, noticeAfter.notice); assert.equal(detail.updatedAt, noticeAfter.updatedAt);
      const today = data(await site.tool(keys.read, 'list_tasks')).today;
      assert.equal(data(await site.tool(keys.read_import, 'review_period', { from: today, to: today })).changes.length, 3);
      assert.equal((await site.call('/api/tasks', { cookie: aliceCookie })).body.tasks[0].id, task.id);
      assert.equal((await site.rpc(keys.import, 'tools/list')).body.result.tools.length, 1);
    });
  } finally { await site.close(); removeFixture(directory); }
});

test('旧权限迁移原表追加 planner_access，旧密钥权限及哈希不变', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhihui-planner-migration-'));
  const filename = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(filename);
  legacy.exec('CREATE TABLE standalone_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const file of ['drizzle/0000_sparkling_frog_thor.sql', 'standalone/migrations/0001_email_auth.sql', 'standalone/migrations/0002_agent_permissions.sql', 'standalone/migrations/0003_custom_categories.sql']) {
    legacy.exec(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO standalone_migrations VALUES (?, ?)').run(file, Date.now());
  }
  legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('legacy-owner', 'legacy-planner@example.test', 'fixture-hash', Date.now());
  legacy.exec('CREATE TABLE migration_guard (key_id TEXT); CREATE TRIGGER legacy_key_guard AFTER INSERT ON agent_keys BEGIN INSERT INTO migration_guard VALUES (new.id); END;');
  const previous = [];
  for (const [index, permission] of ['import', 'read', 'read_import'].entries()) {
    const token = 'zhi_' + String.fromCharCode(65 + index).repeat(43), hash = createHash('sha256').update(token).digest('hex');
    const id = `legacy-${permission}`;
    legacy.prepare('INSERT INTO agent_keys (id,user_id,name,prefix,token_hash,created_at,expires_at,permission) VALUES (?,?,?,?,?,?,?,?)').run(id, 'legacy-owner', id, token.slice(0, 12), hash, Date.now(), Date.now() + 86400000, permission);
    previous.push({ id, permission, token, hash });
  }
  const rootPage = legacy.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'agent_keys'").get().rootpage;
  legacy.close();
  let site = await fixture(filename);
  try {
    const sqlite = site.app.database.sqlite;
    assert.equal(sqlite.prepare("SELECT rootpage FROM sqlite_master WHERE type = 'table' AND name = 'agent_keys'").get().rootpage, rootPage);
    assert.ok(sqlite.prepare('PRAGMA table_info(agent_keys)').all().some(column => column.name === 'planner_access'));
    const schema = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_keys'").get().sql;
    assert.match(schema, /permission IN \('import', 'read', 'read_import'\)/);
    assert.ok(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'legacy_key_guard'").get());
    for (const key of previous) {
      const row = sqlite.prepare('SELECT permission, planner_access, token_hash FROM agent_keys WHERE id = ?').get(key.id);
      assert.deepEqual({ ...row }, { permission: key.permission, planner_access: 0, token_hash: key.hash });
      assert.equal(createAuth(sqlite).agent(new Headers({ Authorization: `Bearer ${key.token}` })).permission, key.permission);
      const names = (await site.rpc(key, 'tools/list')).body.result.tools.map(tool => tool.name);
      assert.ok(!names.some(name => writerTools.includes(name)));
      assert.equal(names.includes('list_tasks'), key.permission !== 'import');
    }
    const manage = createAuth(sqlite).createKey('legacy-owner', '升级后管理密钥', 'manage');
    assert.deepEqual({ ...sqlite.prepare('SELECT permission, planner_access FROM agent_keys WHERE id = ?').get(manage.id) }, { permission: 'read_import', planner_access: 1 });
    assert.ok(sqlite.prepare('SELECT key_id FROM migration_guard WHERE key_id = ?').get(manage.id));
    await site.close(); site = await fixture(filename);
    assert.equal(createAuth(site.app.database.sqlite).keys('legacy-owner').find(key => key.id === manage.id).permission, 'manage');
    for (const key of previous) assert.equal(createAuth(site.app.database.sqlite).keys('legacy-owner').find(value => value.id === key.id).permission, key.permission);
  } finally { await site.close(); removeFixture(directory); }
});
