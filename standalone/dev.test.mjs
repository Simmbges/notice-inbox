import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
test('源码 CMD 直接启动网站，中文空格路径可用，data 可写', { skip: process.platform !== 'win32', timeout: 20000 }, async t => {
  const base = join(project, '.sites-local/source-qa'); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, '源码 中文 空格 '));
  // 不复制便携启动器，验证源码入口不再依赖命名管道。
  const files = ['启动调试.cmd', 'standalone/server.mjs', 'standalone/database.mjs', 'standalone/auth.mjs', 'standalone/mcp.mjs', 'standalone/agent-notices.mjs', 'standalone/categories.mjs', 'standalone/planner-api.mjs', 'standalone/event-store.mjs', 'standalone/task-store.mjs', 'app/panel.html', 'lib/notice-input.ts', 'lib/notice-store.ts'];
  for (const file of files) { mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(project, file), join(root, file)); }
  for (const folder of ['public', 'standalone/public', 'standalone/migrations', 'drizzle']) cpSync(join(project, folder), join(root, folder), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  // 测试副本随输入关闭而退出，避免依赖 Windows 进程树管理权限。
  appendFileSync(join(root, 'standalone/server.mjs'), '\nprocess.stdin.resume(); process.stdin.on("end", () => process.emit("SIGTERM"));\n');
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${probe.address().port}`;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, PATH: dirname(process.execPath) + ';' + process.env.PATH, PORT: new URL(origin).port, APP_URL: origin, DATA_DIR: join(root, 'data'), HOST: '127.0.0.1', NODE_ENV: 'development', TRUST_PROXY: '' };
  const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${join(root, '启动调试.cmd')}" --no-browser"`], { cwd: base, env, windowsHide: true, windowsVerbatimArguments: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString('utf8'); });
  child.stderr.on('data', chunk => { output += chunk.toString('utf8'); });
  t.after(async () => {
    if (child.exitCode === null) {
      const closed = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end();
      await closed;
    }
    assert.ok(resolve(root).startsWith(resolve(base) + sep)); rmSync(root, { recursive: true, force: true });
  });
  for (let i = 0; !output.includes('知会独立版已启动'); i++) {
    if (child.exitCode !== null || i > 100) throw new Error('启动失败：' + output);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await fetch(origin + '/healthz')).status, 200);
  assert.ok((await (await fetch(origin + '/login')).text()).includes('登录知会'));
  assert.ok(existsSync(join(root, 'data/notice-inbox.sqlite')));
  const response = await fetch(origin + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'debug@example.test', password: 'Debug-fixture-only-2026' }) });
  assert.equal(response.status, 200);
});
