import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const declarations = script.match(/^let scheduleResult[^\n]+;/m)?.[0];
const api = script.slice(script.indexOf('async function api('), script.indexOf('\nasync function refreshNotices('));
const loadSchedule = script.slice(script.indexOf('async function loadSchedule()'), script.indexOf('\nfunction applyScheduleRange('));
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const page = title => ({ events: [{ id: title, title }], total: 1, hasMore: false, limit: 200, offset: 0 });

function browser() {
  assert.ok(declarations && api && loadSchedule, '必须提取实际浏览器脚本，不能使用替代实现');
  const requests = [], renders = [], nodes = new Map();
  const context = {
    URLSearchParams, AbortSignal,
    document: { body: { dataset: { auth: 'email' } } },
    location: { assign() { throw new Error('测试不应跳转登录。'); } },
    state: { view: 'schedule' },
    scheduleState: { from: '2026-10-19', to: '2026-10-25', kind: 'all', type: 'all' },
    $: id => { if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '' }); return nodes.get(id); },
    renderSchedule: () => renders.push(clone(context.ScheduleFetch.snapshot().result)),
    fetch: (url, options) => new Promise(resolve => {
      requests.push({ url, method: options.method, respond(body) { resolve({ status: 200, ok: true, redirected: false, json: async () => clone(body) }); } });
    }),
  };
  runInNewContext(`${declarations}\n${api}\n${loadSchedule}\nglobalThis.ScheduleFetch = { load: loadSchedule, snapshot: () => ({ result: scheduleResult, generation: scheduleGeneration, inFlight: scheduleInFlight }) };`, context);
  return { context, requests, renders, load: context.ScheduleFetch.load, snapshot: () => clone(context.ScheduleFetch.snapshot()) };
}

test('相同时间表查询在途时轮询复用请求，慢响应仍可成功展示', async () => {
  const site = browser();
  const first = site.load(); await flush();
  assert.equal(site.requests.length, 1);
  // 多次轮询发生在第一个响应之前，相当于网络耗时超过轮询间隔。
  for (let index = 0; index < 3; index++) await site.load();
  assert.equal(site.requests.length, 1); assert.equal(site.snapshot().generation, 1);
  site.requests[0].respond(page('慢请求的有效结果'));
  await first;
  assert.equal(site.snapshot().result.events[0].title, '慢请求的有效结果');
  assert.equal(site.renders.length, 1); assert.equal(site.snapshot().inFlight, '');
  const next = site.load(); await flush();
  assert.equal(site.requests.length, 2, '上一轮完成后仍能正常发起后续刷新');
  site.requests[1].respond(page('下一轮新结果')); await next;
  assert.equal(site.snapshot().result.events[0].title, '下一轮新结果');
});

test('更换日期范围启动新查询，旧范围响应不能覆盖较新的结果', async () => {
  const site = browser();
  const previous = site.load(); await flush();
  site.context.scheduleState.from = '2026-11-02'; site.context.scheduleState.to = '2026-11-08';
  const current = site.load(); await flush();
  assert.equal(site.requests.length, 2);
  assert.equal(new URL(site.requests[0].url, 'http://fixture.test').searchParams.get('from'), '2026-10-19');
  assert.equal(new URL(site.requests[1].url, 'http://fixture.test').searchParams.get('from'), '2026-11-02');
  site.requests[1].respond(page('新范围')); await current;
  site.requests[0].respond(page('旧范围迟到')); await previous;
  assert.equal(site.snapshot().result.events[0].title, '新范围');
  assert.deepEqual(site.renders.map(result => result.events[0].title), ['新范围']);
});

test('旧筛选请求先结束时不能清除新请求的在途标记或触发重复轮询', async () => {
  const site = browser();
  const previous = site.load(); await flush();
  site.context.scheduleState.kind = 'deadline';
  const current = site.load(); await flush();
  assert.equal(site.requests.length, 2);
  site.requests[0].respond(page('旧筛选')); await previous;
  assert.equal(site.snapshot().result, null);
  assert.equal(site.snapshot().generation, 2); assert.match(site.snapshot().inFlight, /deadline/);
  await site.load();
  assert.equal(site.requests.length, 2, '旧请求的 finally 不应解除新查询的在途保护');
  site.requests[1].respond(page('当前截止事项')); await current;
  assert.equal(site.snapshot().result.events[0].title, '当前截止事项');
  assert.equal(site.snapshot().inFlight, '');
  assert.deepEqual(site.renders.map(result => result.events[0].title), ['当前截止事项']);
});
