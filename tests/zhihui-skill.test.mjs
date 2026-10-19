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

test('空结果和时间待确认可以单独展示，不生成假的日程', () => {
  const html = renderTimeline({ ...report(), undated: [{ title: '待定活动', noticeId: 'pending', reason: '尚未公布日期。' }] });
  assert.ok(html.includes('没有该范围内时间明确的安排')); assert.ok(html.includes('待定活动'));
  assert.ok(!html.includes('<section class="day">'));
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
    const imported = await call('import_notices', { notices: [
      { title: '自编测试：讲座', content: '2026年10月20日14:00举行讲座，地点为报告厅。', category: '校园活动', deadline: '' },
      { title: '自编测试：报名', content: '2026年10月23日前报名，2026年10月24日10:00活动开始。', deadline: '2026-10-23' },
    ] });
    assert.equal(imported.imported, 2);
    const first = await call('list_notices', { limit: 1 });
    assert.equal(first.hasMore, true);
    const second = await call('list_notices', { limit: 1, offset: 1 });
    assert.equal(second.hasMore, false);
    const originals = await Promise.all([...first.notices, ...second.notices].map(n => call('get_notice', { id: n.id })));
    const lecture = originals.find(r => r.notice.title.includes('讲座')).notice;
    const signup = originals.find(r => r.notice.title.includes('报名')).notice;
    const html = renderTimeline({ ...report(), events: [
      event({ title: lecture.title, noticeId: lecture.id, time: '14:00', evidence: lecture.content }),
      event({ title: signup.title, noticeId: signup.id, date: signup.deadline, kind: '报名截止', evidence: signup.content }),
      event({ title: signup.title, noticeId: signup.id, date: '2026-10-24', time: '10:00', evidence: signup.content }),
    ] });
    assert.ok(html.includes(lecture.id)); assert.ok(html.includes(signup.id)); assert.ok(html.includes('10 / 24'));
    const download = await fetch(`${origin}/agent-skill.zip`);
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'application/zip');
    assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); app.database.close(); rmSync(directory, { recursive: true, force: true }); }
});
