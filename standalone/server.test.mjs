import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createApplication } from './server.mjs';
import { createAuth } from './auth.mjs';

async function fixture(databaseFile) {
  let app;
  const server = createServer((request, response) => app.handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ databaseFile, origin });
  return {
    app, origin,
    async call(path, { method = 'GET', body, cookie, token, headers = {} } = {}) {
      const response = await fetch(origin + path, { method, redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
      const text = await response.text();
      return { status: response.status, headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0], body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
    },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); },
  };
}

test('独立版邮箱登录、Agent 密钥和通知库的真实 HTTP 流程', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-auth-test-'));
  const databaseFile = join(directory, 'test.sqlite');
  let site = await fixture(databaseFile);
  let aliceCookie, bobCookie, key, noticeId;
  const alice = { email: 'Alice@example.test', password: 'Fixture-alice-password-2026' };
  const bob = { email: 'bob@example.test', password: 'Fixture-bob-password-2026' };
  const notice = { title: '自动导入测试', content: '这是测试原文，不是真实通知。', deadline: '' };
  try {
    await t.test('邮箱注册建立会话；密码和会话不以明文存储', async () => {
      assert.equal((await site.call('/')).headers.get('location'), '/login');
      const loginPage = await site.call('/login');
      assert.equal(loginPage.status, 200); assert.ok(loginPage.body.includes('邮箱和密码'));
      assert.ok(!loginPage.body.includes('auth.openai.com'));
      const a = await site.call('/api/auth/register', { method: 'POST', body: alice });
      const b = await site.call('/api/auth/register', { method: 'POST', body: bob });
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      aliceCookie = a.cookie; bobCookie = b.cookie;
      assert.match(a.headers.get('set-cookie'), /HttpOnly/); assert.match(a.headers.get('set-cookie'), /SameSite=Lax/);
      assert.equal(a.body.user.email, 'alice@example.test');
      const stored = site.app.database.sqlite.prepare('SELECT password_hash FROM users WHERE email = ?').get('alice@example.test');
      assert.match(stored.password_hash, /^scrypt:32768:8:3:/); assert.ok(!stored.password_hash.includes(alice.password));
      const session = site.app.database.sqlite.prepare('SELECT token_hash FROM sessions LIMIT 1').get();
      assert.equal(session.token_hash.length, 64); assert.ok(!aliceCookie.includes(session.token_hash));
      assert.equal((await site.call('/', { cookie: aliceCookie })).status, 200);
      const duplicate = await site.call('/api/auth/register', { method: 'POST', body: alice });
      assert.equal(duplicate.status, 409);
      const weak = await site.call('/api/auth/register', { method: 'POST', body: { email: 'weak@example.test', password: 'short' } });
      assert.equal(weak.status, 400);
    });
    await t.test('未登录及伪造平台身份不能读写，登录后才可创建密钥', async () => {
      assert.equal((await site.call('/api/notices')).status, 401);
      assert.equal((await site.call('/api/notices', { headers: { 'oai-authenticated-user-id': 'forged' } })).status, 401);
      assert.equal((await site.call('/api/agent-keys', { method: 'POST', body: { name: 'forbidden' } })).status, 401);
      const response = await site.call('/api/agent-keys', { method: 'POST', cookie: aliceCookie, body: { name: '测试 Agent' } });
      assert.equal(response.status, 200); assert.match(response.body.token, /^zhi_/); key = response.body;
      const metadata = await site.call('/api/agent-keys', { cookie: aliceCookie });
      assert.equal(metadata.body.keys.length, 1); assert.ok(!JSON.stringify(metadata.body).includes(key.token));
      assert.deepEqual((await site.call('/api/agent-keys', { cookie: bobCookie })).body.keys, []);
    });
    await t.test('Agent 写入、去重及面板读取，密钥不能越权读取或修改', async () => {
      const imported = await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: [notice] } });
      assert.equal(imported.status, 200); assert.equal(imported.body.imported, 1); noticeId = imported.body.created[0].id;
      assert.ok(!Object.hasOwn(imported.body.created[0], 'content'));
      const repeat = await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: [notice] } });
      assert.equal(repeat.body.skipped, 1); assert.equal(repeat.body.duplicates[0].id, noticeId);
      assert.equal((await site.call('/api/notices', { cookie: aliceCookie })).body.notices[0].content, notice.content);
      assert.deepEqual((await site.call('/api/notices', { cookie: bobCookie })).body.notices, []);
      assert.equal((await site.call('/api/notices', { token: key.token })).status, 401);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', token: key.token, body: { id: noticeId, patch: { read: true } } })).status, 401);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', cookie: bobCookie, body: { id: noticeId, patch: { title: '篡改' } } })).status, 404);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', cookie: aliceCookie, body: { id: noticeId, patch: { favorite: true } } })).status, 200);
    });
    await t.test('MCP 使用导入密钥，支持发现与导入，不暴露读取工具', async () => {
      const rpc = (method, params = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
      assert.equal((await site.call('/mcp', { method: 'POST', body: rpc('tools/list') })).status, 401);
      const init = await site.call('/mcp', { method: 'POST', token: key.token, body: rpc('initialize') });
      assert.equal(init.body.result.serverInfo.version, '2.1.0');
      const tools = await site.call('/mcp', { method: 'POST', token: key.token, body: rpc('tools/list') });
      assert.deepEqual(tools.body.result.tools.map(t => t.name), ['import_notices']);
      const called = await site.call('/mcp', { method: 'POST', token: key.token, body: rpc('tools/call', { name: 'import_notices', arguments: { notices: [{ ...notice, title: 'MCP 通知' }] } }) });
      assert.equal(called.body.result.structuredContent.imported, 1);
      const invalid = await site.call('/mcp', { method: 'POST', token: key.token, body: rpc('tools/call', { name: 'import_notices', arguments: { notices: [{ ...notice, deadline: '2026-02-30' }] } }) });
      assert.equal(invalid.body.result.isError, true);
    });
    await t.test('跨站请求、来源伪造和越权撤销被拒绝', async () => {
      assert.equal((await site.call('/api/agent-keys', { method: 'POST', cookie: aliceCookie, body: { name: 'x' }, headers: { Origin: 'https://evil.test' } })).status, 403);
      const wrongHost = await new Promise((resolve, reject) => {
        const request = httpRequest(`${site.origin}/api/notices`, { headers: { Host: 'evil.test', Cookie: aliceCookie } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
        request.on('error', reject); request.end();
      });
      assert.equal(wrongHost, 400);
      assert.equal((await site.call(`/api/agent-keys/${key.id}`, { method: 'DELETE', cookie: bobCookie })).status, 404);
      assert.equal((await site.call('/data/notice-inbox.sqlite')).status, 404);
      assert.match((await site.call('/login')).headers.get('content-security-policy'), /frame-ancestors 'none'/);
    });
    await t.test('重启后账号、会话及通知仍在；退出会使当前会话失效', async () => {
      await site.close(); site = await fixture(databaseFile);
      assert.equal((await site.call('/api/notices', { cookie: aliceCookie })).body.notices.length, 2);
      const wrong = await site.call('/api/auth/login', { method: 'POST', body: { ...alice, password: 'Incorrect-test-password' } });
      assert.equal(wrong.status, 401);
      assert.equal((await site.call('/api/auth/logout', { method: 'POST', cookie: aliceCookie })).status, 200);
      assert.equal((await site.call('/api/account', { cookie: aliceCookie })).status, 401);
      const login = await site.call('/api/auth/login', { method: 'POST', body: alice });
      assert.equal(login.status, 200); aliceCookie = login.cookie;
      assert.equal((await site.call('/api/notices', { cookie: aliceCookie })).body.notices.length, 2);
    });
    await t.test('撤销立即生效，过期密钥也不能导入', async () => {
      const suppliedIdentity = await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: [{ ...notice, id: noticeId, title: '不能指定已有通知编号', favorite: true, read: true, createdAt: 0 }] } });
      assert.equal(suppliedIdentity.body.imported, 1); assert.notEqual(suppliedIdentity.body.created[0].id, noticeId);
      const fresh = (await site.call('/api/notices', { cookie: aliceCookie })).body.notices.find(n => n.id === suppliedIdentity.body.created[0].id);
      assert.equal(fresh.favorite, false); assert.equal(fresh.read, false); assert.notEqual(fresh.createdAt, 0);
      assert.equal((await site.call(`/api/agent-keys/${key.id}`, { method: 'DELETE', cookie: aliceCookie })).status, 200);
      assert.equal((await site.call('/api/agent/notices', { method: 'POST', token: key.token, body: { notices: [notice] } })).status, 401);
      const expiring = await site.call('/api/agent-keys', { method: 'POST', cookie: aliceCookie, body: { name: '将过期密钥' } });
      site.app.database.sqlite.prepare('UPDATE agent_keys SET expires_at = 0 WHERE id = ?').run(expiring.body.id);
      assert.equal((await site.call('/api/agent/notices', { method: 'POST', token: expiring.body.token, body: { notices: [notice] } })).status, 401);
    });
    await t.test('HTTPS Cookie 属性与登录尝试限制', async () => {
      const secureAuth = createAuth(site.app.database.sqlite, true);
      const loggedIn = await secureAuth.login(alice, 'secure-test-ip', new Headers());
      assert.match(loggedIn.cookie, /^__Host-zhi_session=/); assert.match(loggedIn.cookie, /; Secure/);
      for (let i = 0; i < 3; i++) secureAuth.limit('limit-test', 3, 60000);
      assert.throws(() => secureAuth.limit('limit-test', 3, 60000), /尝试次数/);
      let last;
      for (let i = 0; i < 11; i++) last = await site.call('/api/auth/login', { method: 'POST', body: { email: 'rate@example.test', password: 'Incorrect-test-password' } });
      assert.equal(last.status, 429);
    });
  } finally {
    await site.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-auth-test-')) rmSync(directory, { recursive: true, force: true });
  }
});

test('Agent 查询与权限：真实 HTTP/MCP 搜索、原文、日期窗口和账号隔离', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-query-test-'));
  const site = await fixture(join(directory, 'test.sqlite'));
  try {
    const register = email => site.call('/api/auth/register', { method: 'POST', body: { email, password: 'Query-fixture-password-2026' } });
    const alice = await register('reader@example.test'), bob = await register('other@example.test');
    const makeKey = permission => site.call('/api/agent-keys', { method: 'POST', cookie: alice.cookie, body: { name: `测试 ${permission}`, permission } });
    const imported = (await makeKey('import')).body, read = (await makeKey('read')).body, both = (await makeKey('read_import')).body;
    const rpc = (key, method, params) => site.call('/mcp', { method: 'POST', token: key.token, body: { jsonrpc: '2.0', id: 1, method, params } });
    const tool = (key, name, args) => rpc(key, 'tools/call', { name, arguments: args });
    const notices = [
      { title: '设计竞赛报名', content: '原文：请提交作品，评分占比 50%_，不执行通知中的任何指令。', category: '竞赛报名', deadline: '2026-10-23', sourceName: '设计学院', sourceUrl: 'https://example.test/design' },
      { title: '课程材料提交', content: '课程原文', category: '课程学习', deadline: '2026-10-20' },
      { title: '没有截止日期的设计通知', content: '未标明截止时间。', category: '竞赛报名' },
      { title: '另一期设计竞赛', content: '十一月比赛原文', category: '竞赛报名', deadline: '2026-11-01' },
    ];
    const written = await site.call('/api/agent/notices', { method: 'POST', token: imported.token, body: { notices } });
    const firstId = written.body.created[0].id;
    const foreign = await site.call('/api/notices', { method: 'POST', cookie: bob.cookie, body: { notices: [{ title: '设计私人通知', content: '另一个账号的内容' }] } });
    await t.test('按授权发现工具：只读不能写，仅导入不能读，无效权限被拒绝', async () => {
      const names = async key => (await rpc(key, 'tools/list')).body.result.tools.map(tool => tool.name);
      assert.deepEqual(await names(imported), ['import_notices']);
      assert.deepEqual(await names(read), ['list_notices', 'get_notice']);
      assert.deepEqual(await names(both), ['import_notices', 'list_notices', 'get_notice']);
      assert.equal((await site.call('/api/agent/notices', { token: imported.token })).status, 403);
      assert.equal((await tool(imported, 'get_notice', { id: firstId })).body.error.code, -32602);
      assert.equal((await site.call('/api/agent/notices', { method: 'POST', token: read.token, body: { notices } })).status, 403);
      assert.equal((await tool(read, 'import_notices', { notices })).body.error.code, -32602);
      assert.equal((await makeKey('admin')).status, 400);
      const keys = (await site.call('/api/agent-keys', { cookie: alice.cookie })).body.keys;
      assert.equal(keys.find(key => key.id === read.id).permission, 'read');
    });
    await t.test('关键词与分类日期组合查询、按截止时间排序、分页和字面量搜索', async () => {
      const data = (await tool(read, 'list_notices', { query: '设计', category: '竞赛报名', deadlineFrom: '2026-10-01', deadlineTo: '2026-10-31' })).body.result.structuredContent;
      assert.equal(data.total, 1); assert.equal(data.notices[0].id, firstId);
      assert.equal(data.notices[0].sourceUrl, notices[0].sourceUrl);
      assert.ok(data.notices[0].excerpt.includes('50%_')); assert.ok(!Object.hasOwn(data.notices[0], 'content'));
      const paged = (await site.call('/api/agent/notices?sort=deadline&limit=1&offset=1', { token: both.token })).body;
      assert.equal(paged.total, 4); assert.equal(paged.notices[0].id, firstId); assert.equal(paged.hasMore, true);
      const last = (await site.call('/api/agent/notices?sort=deadline&offset=3', { token: read.token })).body;
      assert.equal(last.notices[0].deadline, ''); assert.equal(last.hasMore, false);
      assert.equal((await tool(read, 'list_notices', { query: '50%_' })).body.result.structuredContent.total, 1);
      assert.equal((await tool(read, 'list_notices', { query: "' OR 1=1 --" })).body.result.structuredContent.total, 0);
    });
    await t.test('读取原文不改变已读状态，通知编号不能跨账号读取，也不能修改', async () => {
      const detail = (await tool(read, 'get_notice', { id: firstId })).body.result.structuredContent.notice;
      assert.equal(detail.content, notices[0].content); assert.equal(detail.read, false);
      assert.equal((await site.call(`/api/agent/notices/${firstId}`, { token: read.token })).body.notice.content, notices[0].content);
      assert.equal((await tool(read, 'get_notice', { id: foreign.body.created[0].id })).body.result.isError, true);
      assert.equal((await site.call(`/api/agent/notices/${foreign.body.created[0].id}`, { token: both.token })).status, 404);
      assert.equal((await site.call('/api/agent/notices')).status, 401);
      assert.equal((await site.call('/api/notices', { method: 'PATCH', token: both.token, body: { id: firstId, patch: { title: '不能修改' } } })).status, 401);
    });
    await t.test('北京时间相对日期：今天、未来七天、本周周一至周日', async () => {
      const initial = (await tool(read, 'list_notices', {})).body.result.structuredContent;
      assert.equal(initial.timeZone, 'Asia/Shanghai'); assert.match(initial.today, /^\d{4}-\d{2}-\d{2}$/);
      const shift = days => new Date(Date.parse(`${initial.today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
      await site.call('/api/agent/notices', { method: 'POST', token: both.token, body: { notices: [
        { title: '窗口测试今天', content: '时间窗口测试', deadline: initial.today },
        { title: '窗口测试第七天', content: '时间窗口测试', deadline: shift(6) },
        { title: '窗口测试第八天', content: '时间窗口测试', deadline: shift(7) },
      ] } });
      const today = (await tool(read, 'list_notices', { query: '窗口测试', deadlineWindow: 'today' })).body.result.structuredContent;
      assert.equal(today.total, 1); assert.equal(today.filters.deadlineFrom, initial.today);
      const week = (await tool(read, 'list_notices', { query: '窗口测试', deadlineWindow: 'next_7_days' })).body.result.structuredContent;
      assert.equal(week.total, 2); assert.equal(week.filters.deadlineTo, shift(6));
      const calendar = (await tool(read, 'list_notices', { deadlineWindow: 'this_week' })).body.result.structuredContent;
      assert.equal(new Date(`${calendar.filters.deadlineFrom}T00:00:00Z`).getUTCDay(), 1);
      assert.equal(new Date(`${calendar.filters.deadlineTo}T00:00:00Z`).getUTCDay(), 0);
    });
    await t.test('拒绝非法日期、范围、分页和归属参数，空结果如实返回', async () => {
      for (const args of [{ deadlineFrom: '2026-02-30' }, { deadlineFrom: '2026-11-01', deadlineTo: '2026-10-01' }, { deadlineWindow: 'today', deadlineTo: '2026-10-31' }, { category: '伪造分类' }, { limit: 51 }, { offset: -1 }, { owner: 'another-user' }]) assert.equal((await tool(read, 'list_notices', args)).body.result.isError, true);
      assert.equal((await site.call('/api/agent/notices?limit=bad', { token: read.token })).status, 400);
      const empty = (await tool(read, 'list_notices', { query: '不存在的通知关键词' })).body.result.structuredContent;
      assert.equal(empty.total, 0); assert.deepEqual(empty.notices, []);
    });
    await t.test('读取密钥撤销和过期后立刻失效', async () => {
      await site.call(`/api/agent-keys/${read.id}`, { method: 'DELETE', cookie: alice.cookie });
      assert.equal((await tool(read, 'list_notices', {})).status, 401);
      site.app.database.sqlite.prepare('UPDATE agent_keys SET expires_at = 0 WHERE id = ?').run(both.id);
      assert.equal((await site.call('/api/agent/notices', { token: both.token })).status, 401);
    });
  } finally {
    await site.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-query-test-')) rmSync(directory, { recursive: true, force: true });
  }
});

test('旧数据库升级：保留原密钥，旧密钥不会自动获得读取权限', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-migrate-test-'));
  const databaseFile = join(directory, 'legacy.sqlite');
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec('CREATE TABLE standalone_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  for (const file of ['drizzle/0000_sparkling_frog_thor.sql', 'standalone/migrations/0001_email_auth.sql']) {
    legacy.exec(readFileSync(new URL('../' + file, import.meta.url), 'utf8'));
    legacy.prepare('INSERT INTO standalone_migrations VALUES (?, ?)').run(file, Date.now());
  }
  const token = 'zhi_' + 'A'.repeat(43), tokenHash = createHash('sha256').update(token).digest('hex');
  legacy.prepare('INSERT INTO users VALUES (?, ?, ?, ?)').run('legacy-owner', 'legacy@example.test', 'legacy-password-hash', Date.now());
  legacy.prepare('INSERT INTO agent_keys (id,user_id,name,prefix,token_hash,created_at,expires_at) VALUES (?,?,?,?,?,?,?)').run('legacy-key', 'legacy-owner', '原有密钥', token.slice(0, 12), tokenHash, Date.now(), Date.now() + 86400000);
  legacy.close();
  let site = await fixture(databaseFile);
  try {
    const auth = createAuth(site.app.database.sqlite);
    assert.equal(auth.agent(new Headers({ Authorization: `Bearer ${token}` })).permission, 'import');
    assert.equal(auth.keys('legacy-owner')[0].permission, 'import');
    assert.throws(() => auth.agent(new Headers({ Authorization: `Bearer ${token}` }), 'read'), /没有查询权限/);
    assert.equal(site.app.database.sqlite.prepare('SELECT token_hash FROM agent_keys WHERE id = ?').get('legacy-key').token_hash, tokenHash);
    await site.close(); site = await fixture(databaseFile);
    assert.equal(site.app.database.sqlite.prepare('SELECT count(*) AS n FROM agent_keys').get().n, 1);
  } finally {
    await site.close();
    if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('zhi-migrate-test-')) rmSync(directory, { recursive: true, force: true });
  }
});
