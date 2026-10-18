import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
      assert.equal(init.body.result.serverInfo.version, '2.0.0');
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
