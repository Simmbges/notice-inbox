import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const archive = join(projectRoot, 'releases/zhihui-windows-x64.zip');

test('Windows 解压即用包：真实 CMD 启动、端口避让、重复启动、停止与数据恢复', {
  skip: process.platform !== 'win32' || !existsSync(archive), timeout: 60000,
}, async t => {
  const qaRoot = join(projectRoot, '.sites-local/portable-qa');
  mkdirSync(qaRoot, { recursive: true });
  const directory = mkdtempSync(join(qaRoot, '中文 空格 '));
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[void][Reflection.Assembly]::LoadWithPartialName('System.IO.Compression.FileSystem'); [IO.Compression.ZipFile]::ExtractToDirectory($env:ZHIHUI_TEST_ZIP, $env:ZHIHUI_TEST_DIRECTORY)"], {
    env: { ...process.env, ZHIHUI_TEST_ZIP: archive, ZHIHUI_TEST_DIRECTORY: directory }, windowsHide: true,
  });
  const packageRoot = join(directory, '知会本地版');
  const runtime = join(packageRoot, 'runtime/node.exe');
  const launcher = join(packageRoot, 'launcher.mjs');
  const databaseFile = join(packageRoot, 'data/notice-inbox.sqlite');
  let processHandle, closed;
  const blocker = createServer((request, response) => response.end('other-service'));
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { execFileSync(runtime, ['--disable-warning=ExperimentalWarning', launcher, '--stop'], { windowsHide: true, timeout: 15000 }); } catch {}
    if (processHandle && processHandle.exitCode === null) { await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 2000))]); if (processHandle.exitCode === null) processHandle.kill(); }
    await new Promise(resolve => blocker.close(resolve));
    assert.ok(resolve(directory).startsWith(resolve(qaRoot) + sep));
    rmSync(directory, { recursive: true, force: true });
  });
  await t.test('压缩包只含程序、运行环境和说明，不含真实数据或凭据', () => {
    const files = readdirSync(packageRoot, { recursive: true }).map(name => name.replaceAll('\\', '/'));
    assert.ok(existsSync(join(packageRoot, 'runtime/LICENSE')));
    assert.ok(existsSync(join(packageRoot, '启动知会.cmd')));
    assert.ok(existsSync(join(packageRoot, '停止知会.cmd')));
    assert.ok(!files.some(name => /(?:\.sqlite(?:-wal|-shm)?|\.env|\.dpapi)$|(?:^|\/)node_modules\//.test(name)));
    assert.ok(!existsSync(join(packageRoot, 'data')));
  });

  mkdirSync(join(packageRoot, 'data'));
  writeFileSync(join(packageRoot, 'data/launcher.json'), JSON.stringify({ port: blocker.address().port }));
  async function start() {
    processHandle = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${join(packageRoot, '启动知会.cmd')}" --no-browser"`], {
      cwd: directory, windowsVerbatimArguments: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'production', HOST: '0.0.0.0', APP_URL: 'https://invalid.example.test', DATA_DIR: join(directory, 'must-not-be-used') },
    });
    closed = once(processHandle, 'exit');
    let output = '', errors = '';
    processHandle.stdout.setEncoding('utf8');
    processHandle.stderr.setEncoding('utf8');
    processHandle.stdout.on('data', chunk => { output += chunk; });
    processHandle.stderr.on('data', chunk => { errors += chunk; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (output.includes('知会本地版已启动')) return output.match(/http:\/\/127\.0\.0\.1:\d+/)[0];
      if (processHandle.exitCode !== null) throw new Error('启动失败：' + output + errors);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('未等到启动成功：' + output + errors);
  }
  const origin = await start();
  const call = async (path, { body, cookie, token } = {}) => {
    const response = await fetch(origin + path, { redirect: 'manual', method: body ? 'POST' : 'GET', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, cookie: response.headers.get('set-cookie')?.split(';')[0], body: await response.text() };
  };
  let cookie, readerToken;
  await t.test('仅监听本机，避开其他服务，实际页面与资源可以访问', async () => {
    assert.notEqual(new URL(origin).port, String(blocker.address().port));
    assert.equal((await call('/healthz')).status, 200);
    assert.equal((await call('/login')).status, 200);
    for (const file of ['/app.js', '/styles.css', '/account.js']) assert.equal((await call(file)).status, 200);
    assert.equal(await (await fetch(`http://127.0.0.1:${blocker.address().port}`)).text(), 'other-service');
    const sqlite = new DatabaseSync(databaseFile);
    assert.equal(sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 0);
    sqlite.close();
    assert.ok(!existsSync(join(directory, 'must-not-be-used')));
  });
  await t.test('注册并通过 MCP 导入测试通知，面板能读到', async () => {
    const registered = await call('/api/auth/register', { body: { email: 'portable@example.test', password: 'Portable-fixture-only-2026' } });
    assert.equal(registered.status, 200);
    cookie = registered.cookie;
    assert.equal((await call('/api/account', { cookie: `zhi_session=original-site-session; ${cookie}` })).status, 200);
    const keyResult = await call('/api/agent-keys', { cookie, body: { name: '启动包临时测试' } });
    assert.equal(keyResult.status, 200);
    const token = JSON.parse(keyResult.body).token;
    assert.equal(typeof token, 'string');
    const imported = await call('/mcp', { token, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'import_notices', arguments: { notices: [{ title: '启动包测试通知', content: '这是临时测试，不是真实校园通知。' }] } } } });
    assert.equal(imported.status, 200);
    assert.equal(JSON.parse(imported.body).result.structuredContent.imported, 1);
    const listed = await call('/api/notices', { cookie });
    assert.equal(JSON.parse(listed.body).notices[0].title, '启动包测试通知');
  });
  await t.test('重复启动复用原实例；停止另一个文件夹不会影响当前实例', async () => {
    const duplicate = execFileSync(runtime, [launcher, '--no-browser'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ok(duplicate.includes('已经运行'));
    assert.ok(duplicate.includes(origin));
    const otherRoot = join(directory, '其他副本');
    mkdirSync(otherRoot);
    copyFileSync(launcher, join(otherRoot, 'launcher.mjs'));
    const stoppedOther = execFileSync(runtime, [join(otherRoot, 'launcher.mjs'), '--stop'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ok(stoppedOther.includes('没有运行'));
    assert.equal((await call('/healthz')).status, 200);
  });
  await t.test('启动包提供按权限发现、通知查询与原文读取', async () => {
    const key = await call('/api/agent-keys', { cookie, body: { name: '启动包查询测试', permission: 'read_import' } });
    assert.equal(key.status, 200); assert.equal(JSON.parse(key.body).permission, 'read_import');
    readerToken = JSON.parse(key.body).token;
    const discovered = await call('/mcp', { token: readerToken, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
    assert.deepEqual(JSON.parse(discovered.body).result.tools.map(tool => tool.name), ['import_notices', 'list_notices', 'get_notice']);
    const searched = await call('/api/agent/notices?query=' + encodeURIComponent('启动包测试'), { token: readerToken });
    assert.equal(searched.status, 200); assert.equal(JSON.parse(searched.body).total, 1);
    const id = JSON.parse(searched.body).notices[0].id;
    const original = await call('/mcp', { token: readerToken, body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_notice', arguments: { id } } } });
    assert.equal(JSON.parse(original.body).result.structuredContent.notice.content, '这是临时测试，不是真实校园通知。');
  });
  await t.test('停止后重启仍保留账号、会话、通知和访问端口', async () => {
    const stopped = execFileSync(process.env.ComSpec, ['/d', '/s', '/c', `""${join(packageRoot, '停止知会.cmd')}""`], {
      windowsVerbatimArguments: true, windowsHide: true, input: '\r\n', encoding: 'utf8', timeout: 15000,
    });
    assert.ok(stopped.includes('已发送停止请求'));
    assert.equal((await closed)[0], 0);
    const sqlite = new DatabaseSync(databaseFile);
    assert.equal(sqlite.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    sqlite.close();
    assert.equal(await start(), origin);
    assert.equal((await call('/api/account', { cookie })).status, 200);
    assert.equal(JSON.parse((await call('/api/notices', { cookie })).body).notices.length, 1);
    assert.equal((await call('/api/agent/notices', { token: readerToken })).status, 200);
  });
});
