import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/planner.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const taskValue = (patch = {}) => ({ id: 'fixture-task', title: '准备报名材料', notes: '', noticeId: '', status: 'todo', priority: 'normal', dueDate: '2026-10-18', estimatedMinutes: 30, plannedDate: '', plannedStartTime: '', plannedEndTime: '', completedAt: null, createdAt: 1, updatedAt: 1, version: 1, ...patch });
const preferenceValue = { timeZone: 'Asia/Shanghai', dailyCapacityMinutes: 120, bufferMinutes: 15, dayStart: '08:00', dayEnd: '22:00', semesterStart: '', semesterEnd: '', classPeriods: [], notes: '', version: 0 };
const reviewValue = (patch = {}) => ({ completed: [], scheduled: [], due: [], overdue: [], changes: [], changesTruncated: false, ...patch });

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// 仅模拟此脚本所需的 DOM 边界；运行原始浏览器脚本及实际事件处理函数。
function browser(fetcher) {
  const elements = new Map(), listeners = new Map(), messages = [], calls = [], changes = [];
  function element(id) {
    const node = { id, values: {}, children: [], dynamicIds: [], disabled: false, open: false, showModal() { this.open = true; }, close() { this.open = false; } };
    node.elements = new Proxy({}, { get: (_, name) => ({ get value() { return node.values[name]; }, set value(value) { node.values[name] = value; } }) });
    let html = '';
    Object.defineProperty(node, 'innerHTML', {
      get: () => html,
      set(value) {
        for (const childId of node.dynamicIds) elements.delete(childId);
        node.dynamicIds = [];
        html = value;
        const values = Object.fromEntries([...value.matchAll(/<input\b[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"/g)].map(match => [match[1], match[2]]));
        for (const match of value.matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
          const options = [...match[2].matchAll(/<option\b[^>]*\bvalue="([^"]*)"([^>]*)>/g)];
          values[match[1]] = (options.find(option => /\bselected\b/.test(option[2])) || options[0])?.[1] || '';
        }
        for (const match of value.matchAll(/<textarea\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) values[match[1]] = match[2];
        for (const match of value.matchAll(/\bid="([^"]+)"/g)) {
          const child = element(match[1]);
          if (match[1].endsWith('-form')) child.values = { ...values };
          elements.set(child.id, child); node.dynamicIds.push(child.id);
        }
      },
    });
    return node;
  }
  for (const id of ['planner-section', 'planner-dialog']) elements.set(id, element(id));
  const context = {
    Date, Intl, URLSearchParams, AbortSignal,
    location: { assign() { throw new Error('测试不应跳转登录。'); } },
    document: {
      getElementById: id => elements.get(id) || null,
      addEventListener(name, action) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(action); },
      dispatchEvent(event) { if (event.type === 'planner:message') messages.push(event.detail); if (event.type === 'planner:changed') changes.push(event.detail); },
    },
    Event: class { constructor(type) { this.type = type; } },
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    FormData: class {
      constructor(form) { this.values = { ...form.values }; }
      *[Symbol.iterator]() { yield* Object.entries(this.values); }
      getAll(name) { return Object.hasOwn(this.values, name) ? [this.values[name]].flat() : []; }
    },
    ZhihuiEventRules: { today: () => '2026-10-19', shiftDay: (value, offset) => new Date(Date.parse(value) + offset * 86400000).toISOString().slice(0, 10), normalizeEvent: value => value },
    fetch: async (path, options) => {
      const call = { path, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) };
      calls.push(call);
      const response = await fetcher(call);
      const status = response.status ?? 200;
      return { status, ok: status >= 200 && status < 300, json: async () => clone(response.body) };
    },
  };
  runInNewContext(script, context);
  return {
    planner: context.ZhihuiPlanner, calls, messages, changes,
    get: id => elements.get(id),
    async dispatch(type, target) {
      for (const action of listeners.get(type) || []) await action({ target, preventDefault() {}, submitter: { disabled: false } });
    },
  };
}

test('复盘连续完成和重开读取最新任务版本，不受先前任务页缓存影响', async () => {
  let task = taskValue();
  const page = browser(async call => {
    if (call.path === '/api/tasks' && call.method === 'GET') return { body: { tasks: [task] } };
    if (call.path === '/api/tasks' && call.method === 'PATCH') {
      if (call.body.expectedVersion !== task.version) return { status: 409, body: { error: '任务已被更新，请刷新后重试。' } };
      task = { ...task, ...call.body.patch, version: task.version + 1, completedAt: call.body.patch.status === 'done' ? 2 : null };
      return { body: { task } };
    }
    if (call.path.startsWith('/api/review?')) return { body: reviewValue({ completed: task.status === 'done' ? [task] : [], overdue: task.status === 'todo' ? [task] : [] }) };
    throw new Error(`意外请求 ${call.path}`);
  });
  await page.planner.open('tasks');
  await page.planner.open('review'); await flush();
  await page.dispatch('change', { dataset: { taskStatus: task.id }, value: 'done' });
  assert.equal(task.status, 'done');
  await page.dispatch('change', { dataset: { taskStatus: task.id }, value: 'todo' });
  assert.equal(task.status, 'todo'); assert.equal(task.version, 3);
  assert.deepEqual(page.calls.filter(call => call.method === 'PATCH').map(call => call.body.expectedVersion), [1, 2]);
  assert.deepEqual(page.messages.filter(message => message.includes('已被更新')), []);
});

test('偏好保存期间切换到复盘，迟到的保存结果不覆盖新视图', async () => {
  const saving = deferred();
  const page = browser(async call => {
    if (call.path === '/api/preferences' && call.method === 'GET') return { body: preferenceValue };
    if (call.path === '/api/preferences' && call.method === 'PATCH') return saving.promise;
    if (call.path.startsWith('/api/review?')) return { body: reviewValue() };
    throw new Error(`意外请求 ${call.path}`);
  });
  await page.planner.open('preferences');
  const form = page.get('preferences-form');
  form.values = { dailyCapacityMinutes: '90', bufferMinutes: '20', dayStart: '08:00', dayEnd: '22:00', semesterStart: '', semesterEnd: '', notes: '周日晚复盘' };
  const submission = page.dispatch('submit', form);
  await page.planner.open('review'); await flush();
  assert.ok(page.get('review-form'));
  saving.resolve({ body: { ...preferenceValue, dailyCapacityMinutes: 90, version: 1 } });
  await submission; await flush();
  assert.ok(page.get('review-form'), '保存完成后必须保留当前复盘表单');
  assert.equal(page.get('preferences-form'), undefined);
  assert.match(page.get('planner-section').innerHTML, /计划复盘/);
});

test('复盘自定义范围只显示最新请求结果，旧窗口迟到不会覆盖', async () => {
  const requests = [];
  const page = browser(async call => {
    if (!call.path.startsWith('/api/review?')) throw new Error(`意外请求 ${call.path}`);
    const pending = deferred(); requests.push({ ...pending, path: call.path }); return pending.promise;
  });
  await page.planner.open('review'); await flush();
  const form = page.get('review-form');
  form.values = { from: '2026-09-01', to: '2026-09-07' };
  const submission = page.dispatch('submit', form); await flush();
  assert.equal(requests.length, 2);
  requests[1].resolve({ body: reviewValue({ completed: [taskValue({ title: '新窗口完成事项', status: 'done' })] }) });
  await submission;
  requests[0].resolve({ body: reviewValue({ completed: [taskValue({ title: '旧窗口完成事项', status: 'done' })] }) });
  await flush();
  assert.match(page.get('review-result').innerHTML, /新窗口完成事项/);
  assert.doesNotMatch(page.get('review-result').innerHTML, /旧窗口完成事项/);
  const refreshing = page.planner.refresh(); await flush();
  const query = new URLSearchParams(requests[2].path.split('?')[1]);
  assert.equal(query.get('from'), '2026-09-01'); assert.equal(query.get('to'), '2026-09-07');
  requests[2].resolve({ body: reviewValue() }); await refreshing;
});

test('任务请求尚未返回时切到日程，自动加载新视图而无需等待轮询', async () => {
  const loading = deferred();
  const page = browser(async call => {
    if (call.path === '/api/tasks') return loading.promise;
    if (call.path === '/api/event-rules') return { body: { events: [] } };
    throw new Error(`意外请求 ${call.path}`);
  });
  const first = page.planner.open('tasks'); await flush();
  const next = page.planner.open('events');
  loading.resolve({ body: { tasks: [] } });
  await Promise.all([first, next]); await flush();
  assert.ok(page.calls.some(call => call.path === '/api/event-rules'), '切换日程后必须发出对应请求');
  assert.match(page.get('planner-section').innerHTML, /日程与课程/);
  assert.doesNotMatch(page.get('planner-section').innerHTML, /正在读取/);
});

test('离开的偏好页迟到报错，不覆盖当前复盘视图', async () => {
  const loading = deferred();
  const page = browser(async call => {
    if (call.path === '/api/preferences') return loading.promise;
    if (call.path.startsWith('/api/review?')) return { body: reviewValue() };
    throw new Error(`意外请求 ${call.path}`);
  });
  const first = page.planner.open('preferences'); await flush();
  await page.planner.open('review'); await flush();
  loading.resolve({ status: 500, body: { error: '旧偏好查询失败' } });
  await first; await flush();
  assert.ok(page.get('review-form'), '旧页面的错误不应销毁当前页面');
  assert.match(page.get('planner-section').innerHTML, /计划复盘/);
  assert.doesNotMatch(page.get('planner-section').innerHTML, /旧偏好查询失败/);
});

test('新建日程交给统一编辑器，保留默认分类和自定义分类上下文', () => {
  const page = browser(async () => { throw new Error('打开统一编辑器前不应请求。'); });
  const opened = [];
  page.planner.setEventEditor(options => { opened.push(clone(options)); return 'opened'; });
  page.planner.setCategories(['日程', '课程', '科研', '其他通知']);
  assert.equal(page.planner.newEvent(), 'opened');
  page.planner.newEvent('科研', true);
  assert.deepEqual(opened, [
    { category: '日程', recurring: false, recordType: 'schedule' },
    { category: '科研', recurring: true, recordType: 'schedule' },
  ]);
  assert.equal(page.get('planner-dialog').open, false);
  assert.equal(page.calls.length, 0);
});

test('课程默认每周重复，也可明确选择一次性课程', () => {
  const page = browser(async () => { throw new Error('新建不应请求。'); });
  const opened = [];
  page.planner.setEventEditor(options => opened.push(clone(options)));
  page.planner.newEvent(undefined, undefined, 'course');
  page.planner.newEvent(undefined, false, 'course');
  page.planner.newEvent(undefined, true, 'schedule');
  assert.deepEqual(opened, [
    { category: '课程', recurring: true, recordType: 'course' },
    { category: '课程', recurring: false, recordType: 'course' },
    { category: '日程', recurring: true, recordType: 'schedule' },
  ]);
});

test('默认分类改名或删除后，新建仍使用当前可用的分类', () => {
  const page = browser(async () => { throw new Error('新建不应请求。'); });
  const opened = [];
  page.planner.setEventEditor(options => opened.push(clone(options)));
  page.planner.setCategories(['个人安排', '课堂学习', '科研', '其他通知']);
  page.planner.setDefaultCategories('个人安排', '课堂学习');
  page.planner.newEvent();
  page.planner.newEvent(undefined, undefined, 'course');
  page.planner.newEvent('已删除');
  assert.deepEqual(opened.map(item => item.category), ['个人安排', '课堂学习', '其他通知']);
});

test('编辑只传事件ID给统一编辑器，由统一入口负责实时读取版本', async () => {
  const page = browser(async () => { throw new Error('旧日程编辑器不应再读取副本。'); });
  const pending = deferred(), opened = [];
  page.planner.setEventEditor(options => { opened.push(clone(options)); return pending.promise; });
  const opening = page.planner.openEvent('fixture-course');
  assert.deepEqual(opened, [{ id: 'fixture-course', source: 'event' }]);
  pending.resolve('ready');
  assert.equal(await opening, 'ready');
  assert.equal(page.get('planner-dialog').open, false);
  assert.equal(page.calls.length, 0);
});

test('内部日程列表的新建编辑按钮均进入统一编辑器，保留异步错误提示', async () => {
  const page = browser(async call => {
    assert.equal(call.path, '/api/event-rules');
    return { body: { events: [] } };
  });
  const opened = [];
  page.planner.setEventEditor(async options => { opened.push(clone(options)); if (options.id === 'failed') throw new Error('统一编辑器读取失败'); });
  await page.planner.open('events');
  await page.dispatch('click', { closest: () => ({ dataset: { planner: 'add-event' } }) });
  await page.dispatch('click', { closest: () => ({ dataset: { planner: 'edit-event', id: 'course' } }) });
  await page.dispatch('click', { closest: () => ({ dataset: { planner: 'edit-event', id: 'failed' } }) });
  assert.deepEqual(opened, [
    { category: '日程', recurring: false, recordType: 'schedule' },
    { id: 'course', source: 'event' }, { id: 'failed', source: 'event' },
  ]);
  assert.ok(page.messages.includes('统一编辑器读取失败'));
});

test('单次调课继续读取最新父版本，并只修改指定日期', async () => {
  const course = { id: 'fixture-course', title: '高等数学', recordType: 'course', version: 5, date: '2026-09-07', time: '08:00', endTime: '09:40', location: 'A101', recurrence: { until: '2027-01-10', weekdays: [1], intervalWeeks: 1, weeks: [], excludeDates: [] } };
  const page = browser(async call => {
    if (call.path === '/api/event-rules') return { body: { events: [course] } };
    assert.equal(call.path, '/api/event-occurrence'); assert.equal(call.method, 'PATCH');
    return { body: {} };
  });
  await page.planner.openOccurrence(course.id, '2026-10-26');
  const form = page.get('planner-edit-form');
  assert.equal(page.get('planner-dialog').open, true);
  Object.assign(form.values, { date: '2026-10-27', time: '10:00', endTime: '11:40', location: 'B202' });
  await page.dispatch('submit', form);
  assert.deepEqual(page.calls.find(call => call.method === 'PATCH').body, { id: course.id, expectedVersion: 5, occurrenceDate: '2026-10-26', changes: { date: '2026-10-27', time: '10:00', endTime: '11:40', location: 'B202' } });
  assert.equal(page.get('planner-dialog').open, false);
  assert.match(page.messages.at(-1), /仅本次安排已调整/);
});
