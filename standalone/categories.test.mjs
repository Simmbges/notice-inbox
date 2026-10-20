import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from './server.mjs';
import { createAuth } from './auth.mjs';
import { createCategoryStore } from './categories.mjs';
import { importNotices, listNotices } from '../lib/notice-store.ts';

test('自定义分类：账号隔离、通知同步、MCP 和重启持久化', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'zhi-categories-'));
  const databaseFile = join(directory, 'test.sqlite');
  let app;
  const server = createServer((request, response) => app.handler(request, response));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  app = createApplication({ databaseFile, origin });
  const call = async (path, method = 'GET', body, cookie, token, extra = {}) => {
    const response = await fetch(origin + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  };
  const auth = createAuth(app.database.sqlite);
  const a = await auth.register({ email: 'a@example.test', password: 'Fixture-category-A-2026' }, 'fixture-a', new Headers());
  const b = await auth.register({ email: 'b@example.test', password: 'Fixture-category-B-2026' }, 'fixture-b', new Headers());
  const cookieA = a.cookie.split(';')[0], cookieB = b.cookie.split(';')[0];
  const key = auth.createKey(a.user.id, '读写测试', 'read_import');
  const tool = async (name, args) => call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, null, key.token);
  let id;
  try {
    await t.test('初始分类兼容旧数据，新增与校验仅作用于当前账号', async () => {
      assert.equal((await call('/api/categories')).status, 401);
      const initial = (await call('/api/categories', 'GET', null, cookieA)).data.categories;
      assert.equal(initial.length, 7); assert.equal(initial.at(-1), '其他通知'); assert.ok(initial.includes('日程')); assert.ok(initial.includes('课程'));
      assert.equal((await call('/api/categories', 'POST', { name: '  实习招聘  ' }, cookieA)).status, 200);
      assert.equal((await call('/api/categories', 'POST', { name: '实习招聘' }, cookieA)).status, 409);
      assert.ok(!(await call('/api/categories', 'GET', null, cookieB)).data.categories.includes('实习招聘'));
      for (const name of ['', ' ', '长'.repeat(31), '两行\n分类', null]) assert.equal((await call('/api/categories', 'POST', { name }, cookieA)).status, 400);
      assert.equal((await call('/api/categories', 'POST', { name: '<b>"项目"</b>' }, cookieA)).status, 200);
      assert.equal((await call('/api/categories', 'POST', { name: '跨站' }, cookieA, null, { Origin: 'https://untrusted.example' })).status, 403);
      assert.equal((await call('/api/categories', 'POST', { name: 'Agent不能管理分类' }, null, key.token)).status, 401);
    });
    await t.test('MCP 发现当前分类，导入和查询支持新分类，未知分类不静默降级', async () => {
      const discovery = await call('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, null, key.token);
      const schema = discovery.data.result.tools.find(t => t.name === 'import_notices').inputSchema;
      assert.ok(schema.properties.notices.items.properties.category.enum.includes('实习招聘'));
      const imported = await tool('import_notices', { notices: [{ title: '实习招聘测试', content: '保留这段原文。', category: '实习招聘' }] });
      assert.equal(imported.data.result.isError, false); id = imported.data.result.structuredContent.created[0].id;
      const listed = await tool('list_notices', { category: '实习招聘' });
      assert.equal(listed.data.result.structuredContent.total, 1);
      assert.ok(listed.data.result.structuredContent.categories.includes('实习招聘'));
      assert.equal((await tool('import_notices', { notices: [{ title: '未知分类', content: '不应保存', category: '不存在' }] })).data.result.isError, true);
      assert.equal((await call('/api/notices', 'PATCH', { id, patch: { favorite: true, read: true } }, cookieA)).status, 200);
    });
    await t.test('重命名同步已有通知与筛选，删除只迁移分类不改变原文、编号和状态', async () => {
      await call('/api/notices', 'POST', { notices: [{ title: '其他账号的通知', content: '原文B', category: '课程学习' }] }, cookieB);
      assert.equal((await call('/api/categories', 'PATCH', { name: '课程学习', newName: '研讨课程' }, cookieA)).status, 200);
      assert.ok((await call('/api/categories', 'GET', null, cookieB)).data.categories.includes('课程学习'));
      assert.equal((await call('/api/categories', 'PATCH', { name: '实习招聘', newName: '求职信息' }, cookieA)).status, 200);
      assert.equal((await tool('list_notices', { category: '求职信息' })).data.result.structuredContent.total, 1);
      assert.equal((await tool('list_notices', { category: '实习招聘' })).data.result.isError, true);
      assert.equal((await call('/api/categories', 'PATCH', { name: '求职信息', newName: '其他通知' }, cookieA)).status, 409);
      assert.equal((await call('/api/categories', 'DELETE', { name: '求职信息' }, cookieA)).status, 200);
      const saved = (await tool('get_notice', { id })).data.result.structuredContent.notice;
      assert.equal(saved.category, '其他通知'); assert.equal(saved.content, '保留这段原文。'); assert.equal(saved.id, id);
      assert.equal(saved.favorite, true); assert.equal(saved.read, true);
      for (const method of ['PATCH', 'DELETE']) assert.equal((await call('/api/categories', method, { name: '其他通知', newName: '改名' }, cookieA)).status, 400);
    });
    await t.test('分类变更和通知异步保存并发时，不遗留被删除的旧分类', async () => {
      const store = createCategoryStore(app.database.sqlite);
      store.change(a.user.id, 'POST', { name: '并发旧分类' });
      const pending = importNotices(app.database.db, a.user.id, [{ title: '并发通知', content: '不能落入已删除分类', category: '并发旧分类' }], 'manual', () => store.list(a.user.id));
      store.change(a.user.id, 'PATCH', { name: '并发旧分类', newName: '并发新分类' });
      await assert.rejects(pending, error => error.status === 409);
      assert.ok(!(await listNotices(app.database.db, a.user.id)).some(n => n.category === '并发旧分类'));
    });
    await t.test('关闭并重新打开数据库后，空分类和原有通知仍保留', async () => {
      app.database.close();
      app = createApplication({ databaseFile, origin });
      const names = (await call('/api/categories', 'GET', null, cookieA)).data.categories;
      assert.ok(names.includes('并发新分类')); assert.ok(names.includes('<b>"项目"</b>')); assert.ok(!names.includes('求职信息'));
      assert.equal((await tool('get_notice', { id })).data.result.structuredContent.notice.content, '保留这段原文。');
    });
    await t.test('分类数量上限不会破坏已有分类', async () => {
      const store = createCategoryStore(app.database.sqlite);
      while (store.list(a.user.id).length < 30) store.change(a.user.id, 'POST', { name: `分类${store.list(a.user.id).length}` });
      assert.throws(() => store.change(a.user.id, 'POST', { name: '第31个' }));
      assert.equal(store.list(a.user.id).length, 30);
    });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
