import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const rulesScript = readFileSync(new URL('../public/event-rules.js', import.meta.url), 'utf8');
const scheduleScript = readFileSync(new URL('../public/schedule.js', import.meta.url), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
const flush = () => new Promise(resolve => setImmediate(resolve));
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-10-20T12:00:00+08:00'])); }
  static now() { return Date.parse('2026-10-20T12:00:00+08:00'); }
}
const notice = { id: 'shared-id', title: '报名材料', content: '保留原文', category: '校园事务', deadline: '2099-01-02', events: [], createdAt: 1, updatedAt: 1 };
const course = { id: 'shared-id', title: '高等数学', recordType: 'course', category: '课程', date: '2026-09-07', time: '08:00', endTime: '09:40', location: 'A302', createdAt: 2, version: 1, active: true, favorite: false, recurrence: { until: '2027-01-01', weekdays: [1, 3], intervalWeeks: 1, weeks: [], excludeDates: [] }, nextOccurrence: { date: '2026-10-21', time: '08:00', endTime: '09:40', eventId: 'shared-id', occurrenceDate: '2026-10-21' }, scheduleStatus: 'upcoming' };

function store(call, data) {
  if (call.method === 'GET') return { body: call.path === '/api/event-rules' ? { events: data.eventRules } : data };
  if (call.path === '/api/notices' && call.method === 'POST') {
    data.notices.push(...clone(call.body.notices));
    return { body: { imported: call.body.notices.length, skipped: 0, created: call.body.notices.map(({ id }) => ({ id })) } };
  }
  const items = call.path === '/api/events' ? data.eventRules : data.notices;
  const item = items.find(item => item.id === call.body.id);
  Object.assign(item, clone(call.body.patch));
  return { body: { event: item } };
}

// 使用真实归一化与保存函数；只替代浏览器 DOM、时间控件和 HTTP 边界。
function browser(data, fetcher = store) {
  const elements = new Map(), listeners = new Map(), calls = [], renders = [];
  let eventEditor, defaultCategories = { schedule: '日程', course: '课程' };
  const timeKeys = ['title', 'date', 'time', 'endDate', 'endTime', 'kind', 'evidence', 'recurrence'];
  function timeRow(data) {
    const result = { data, dataset: {}, querySelectorAll: () => [], querySelector: () => ({ focus() {} }) };
    result.remove = () => { node('event-fields').children = node('event-fields').children.filter(row => row !== result); };
    return result;
  }
  function node(id) {
    if (!elements.has(id)) {
      const element = { id, name: id.split(':').at(-1), textContent: '', value: '', checked: false, hidden: false, open: false, disabled: false, children: [], dataset: {}, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }, classList: { add() {}, remove() {}, toggle() {} }, elements: { namedItem: name => node(`${id}:${name}`) }, addEventListener(name, action) { listeners.set(`${id}:${name}`, action); }, querySelector() { return { insertAdjacentHTML() {}, closest() { return { hidden: false }; } }; }, querySelectorAll: () => [], showModal() { this.open = true; }, close() { this.open = false; }, reset() { for (const field of elements.values()) if (field.id.startsWith(`${id}:`)) { field.value = ''; field.checked = false; field.disabled = false; } }, focus() { this.focused = true; }, scrollIntoView() {} };
      let html = '';
      Object.defineProperty(element, 'innerHTML', { get: () => html, set(value) {
        html = value;
        if (id === 'notice-list') renders.push(value);
        if (id === 'event-fields') element.children = [...value.matchAll(/<test-time data-value="([^"]+)"><\/test-time>/g)].map(match => timeRow(JSON.parse(decodeURIComponent(match[1]))));
      } });
      element.insertAdjacentHTML = (_, value) => { if (id === 'event-fields') { html += value; element.children.push(...[...value.matchAll(/<test-time data-value="([^"]+)"><\/test-time>/g)].map(match => timeRow(JSON.parse(decodeURIComponent(match[1]))))); } else element.innerHTML += value; };
      Object.defineProperty(element, 'lastElementChild', { get: () => element.children.at(-1) });
      elements.set(id, element);
    }
    return elements.get(id);
  }
  const planner = {
    setCategories() {}, setDefaultCategories(schedule, course) { defaultCategories = { schedule, course }; }, setEventEditor(handler) { eventEditor = handler; }, deactivate() {}, open() {}, refresh() {},
    newEvent: (category, recurring, recordType = 'schedule') => eventEditor({ category: category || defaultCategories[recordType], recurring: recurring ?? recordType === 'course', recordType }),
    openEvent: id => eventEditor({ id, source: 'event' }),
  };
  const context = {
    Date: FixtureDate, Intl, URL, URLSearchParams, AbortSignal, crypto: { randomUUID: () => 'fixture-id' }, innerWidth: 1265,
    localStorage: { getItem: () => null }, setInterval() {}, setTimeout() {}, clearTimeout() {},
    location: { assign() { throw new Error('不应跳转'); } },
    document: { body: { dataset: { auth: 'email' } }, getElementById: node, querySelectorAll: () => [], addEventListener(name, action) { listeners.set(`document:${name}`, action); } },
    ZhihuiEventEditor: {
      fields(event = {}) { const time = { title: '', date: '', time: '', endDate: '', endTime: '', kind: 'event', evidence: '', recurrence: null }; for (const key of timeKeys) if (event[key] !== undefined) time[key] = event[key]; return `<test-time data-value="${encodeURIComponent(JSON.stringify(time))}"></test-time>`; },
      read(row) { return timeKeys.filter(key => !['kind', 'recurrence'].includes(key)).some(key => row.data[key]) || row.data.recurrence ? clone(row.data) : null; },
      hydrate() {}, sync() {},
    },
    ZhihuiPlanner: planner,
    fetch: async (path, options) => {
      const call = { path, method: options.method, ...(options.body ? { body: JSON.parse(options.body) } : {}) }; calls.push(call);
      const result = await fetcher(call, data);
      return { status: result.status || 200, ok: !result.status || result.status < 400, redirected: false, json: async () => clone(result.body) };
    },
  };
  runInNewContext(rulesScript, context); runInNewContext(scheduleScript, context);
  runInNewContext(`${script}\nglobalThis.InboxTest = { state, entries: listEntries, filtered: filteredNotices, render, refresh: refreshNotices, categoryStyle, openForm, entryDate, entryDeadline };`, context);
  return { ui: context.InboxTest, planner, get: node, field: name => node('notice-form').elements.namedItem(name), calls, renders,
    async click(dataset) { await listeners.get('document:click')({ target: { closest: () => ({ dataset, disabled: false }) } }); },
    async change(id, value, checked) { node(id).value = value; node(id).checked = checked; await listeners.get(`${id}:change`)({ target: node(id) }); },
    async dispatch(type, detail, key) { await listeners.get(`document:${type}`)({ type, detail, key }); },
    async activate(id) { await listeners.get(`${id}:click`)({ target: node(id), stopPropagation() {} }); },
    async submit() { await listeners.get('notice-form:submit')({ preventDefault() {} }); },
    async changeType(value) { const field = node('notice-form:recordType'); field.value = value; await listeners.get('notice-form:change')({ target: field }); },
  };
}
const snapshot = () => ({ notices: [clone(notice)], categories: ['校园事务', '日程', '课程', '其他通知'], scheduleCategory: '日程', courseCategory: '课程', eventRules: [clone(course), { ...clone(course), id: 'once', title: '说明会', recordType: 'schedule', category: '日程', recurrence: null }, { ...clone(course), id: 'cancelled', title: '已取消课程', active: false, scheduleStatus: 'cancelled', nextOccurrence: null }] });

test('统一列表按系列计数且不同来源同编号不会串选，课程详情与普通原文分别展示', async () => {
  const page = browser(snapshot()); await flush();
  assert.equal(page.get('stat-all').textContent, 3);
  assert.equal(page.ui.entries().filter(entry => entry.entryType === 'course').length, 1);
  await page.click({ action: 'select-rule', id: course.id });
  assert.equal(page.ui.state.selected, 'event:shared-id');
  assert.match(page.get('detail-panel').innerHTML, /编辑整个系列/);
  assert.match(page.get('detail-panel').innerHTML, /调整下一次/);
  await page.click({ action: 'select', id: notice.id });
  assert.equal(page.ui.state.selected, 'notice:shared-id');
  assert.match(page.get('detail-panel').innerHTML, /保留原文/);
  assert.doesNotMatch(page.get('detail-panel').innerHTML, /编辑整个系列/);
});

test('课程分类、类型、搜索和已取消筛选可组合，收藏与统计按规则而不是课次', async () => {
  const data = snapshot(); data.eventRules[0].favorite = true;
  const page = browser(data); await flush();
  await page.click({ category: '课程' });
  assert.equal(page.ui.filtered().length, 1);
  await page.change('inbox-type', 'course');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['shared-id']);
  page.ui.state.query = 'A302'; page.ui.render(); assert.equal(page.ui.filtered().length, 1);
  page.ui.state.query = ''; await page.change('inbox-cancelled', '', true);
  assert.equal(page.ui.filtered().length, 2); assert.equal(page.get('stat-all').textContent, 4);
  await page.click({ view: 'favorites' });
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['shared-id']);
});

test('课程收藏读取最新版本并调用日程接口，普通事件不会被误写', async () => {
  const data = snapshot();
  const page = browser(data, call => {
    if (call.path === '/api/notices') return { body: data };
    if (call.path === '/api/event-rules') return { body: { events: [{ ...course, version: 4 }] } };
    assert.equal(call.path, '/api/events'); assert.equal(call.method, 'PATCH');
    assert.equal(call.body.expectedVersion, 4); assert.deepEqual(call.body.patch, { favorite: true });
    data.eventRules[0].favorite = true;
    return { body: { event: data.eventRules[0] } };
  }); await flush();
  await page.click({ action: 'favorite-rule', id: course.id });
  assert.equal(page.get('stat-favorites').textContent, 1);
  assert.equal(page.calls.filter(call => call.path === '/api/notices' && call.method === 'PATCH').length, 0);
});

test('改名分类上下文用于统一表单，替代课次可直接编辑最新记录', async () => {
  const data = snapshot(); data.scheduleCategory = '个人安排'; data.categories[1] = '个人安排'; data.eventRules[0].nextOccurrence.eventId = 'replacement';
  const replacement = { ...clone(course), id: 'replacement', title: '高数临时补课', date: '2026-10-22', recurrence: null, version: 6 };
  const page = browser(data, call => call.path === '/api/event-rules' ? { body: { events: [replacement] } } : store(call, data)); await flush();
  page.ui.state.category = '个人安排'; await page.activate('add-notice');
  assert.equal(page.field('category').value, '个人安排');
  page.ui.state.category = '';
  await page.click({ action: 'select-rule', id: course.id });
  assert.match(page.get('detail-panel').innerHTML, /编辑这次调课/);
  assert.match(page.get('detail-panel').innerHTML, /data-id="replacement"/);
  await page.click({ action: 'edit-rule', id: 'replacement' });
  assert.equal(page.field('title').value, replacement.title);
  assert.equal(page.get('add-event').hidden, true);
  assert.ok(page.calls.some(call => call.path === '/api/event-rules'));
});

test('收藏期间的旧轮询结果不会回退列表，写入结束会补取最新快照', async () => {
  const data = snapshot(); let gets = 0, resolvePrevious;
  const stale = clone(data); stale.eventRules[0].title = '过期快照';
  const page = browser(data, call => {
    if (call.path === '/api/notices') { if (++gets === 2) return new Promise(resolve => { resolvePrevious = resolve; }); return { body: data }; }
    if (call.path === '/api/event-rules') return { body: { events: [course] } };
    data.eventRules[0].favorite = true; data.eventRules[0].title = '最新已收藏';
    return { body: { event: data.eventRules[0] } };
  }); await flush();
  const pending = page.ui.refresh(); await flush();
  await page.click({ action: 'favorite-rule', id: course.id });
  resolvePrevious({ body: stale }); await pending; await flush();
  assert.equal(gets, 3); assert.equal(page.get('stat-favorites').textContent, 1);
  assert.ok(page.renders.some(html => html.includes('最新已收藏')));
  assert.ok(!page.renders.some(html => html.includes('过期快照')));
});

test('从其他视图新建日程后清除类型筛选并选中新卡片', async () => {
  const data = snapshot(), page = browser(data); await flush();
  page.ui.state.view = 'tasks'; page.ui.state.type = 'event'; page.ui.state.category = '校园事务'; page.ui.state.query = '不匹配';
  await page.dispatch('planner:changed', { created: true, eventId: course.id }); await flush();
  assert.equal(page.ui.state.view, 'all'); assert.equal(page.ui.state.type, 'all');
  assert.equal(page.ui.state.category, ''); assert.equal(page.ui.state.query, '');
  assert.equal(page.ui.state.selected, 'event:shared-id');
});

test('添加事件和空列表入口均直接打开统一表单，不再先选普通或日程', async () => {
  const page = browser(snapshot()); await flush();
  await page.activate('add-notice');
  assert.equal(page.get('notice-dialog').open, true);
  assert.equal(page.get('dialog-title').textContent, '添加事件');
  assert.equal(page.field('recordType').value, 'schedule');
  assert.equal(page.get('event-fields').children.length, 1);
  assert.equal(page.get('event-fields').children[0].data.recurrence, null);
  assert.equal(page.field('participation').checked, false);
  const empty = snapshot(); empty.notices = []; empty.eventRules = [];
  const emptyPage = browser(empty); await flush();
  assert.equal(emptyPage.get('empty-state').hidden, false);
  await emptyPage.activate('empty-action');
  assert.equal(emptyPage.get('notice-dialog').open, true);
});

test('只写标题即可保存事件，空时间卡与原文不会产生虚构日程', async () => {
  const data = snapshot(), page = browser(data); await flush();
  page.ui.state.repeat = 'recurring'; page.ui.state.category = '校园事务'; page.ui.state.query = '先前搜索';
  await page.activate('add-notice'); page.field('title').value = '待补充的研究计划';
  await page.submit();
  const saved = page.calls.find(call => call.method === 'POST').body.notices[0];
  assert.equal(saved.title, '待补充的研究计划'); assert.equal(saved.content, '');
  assert.deepEqual(saved.events, []); assert.equal(saved.deadline, '');
  assert.equal(saved.participation, 'reference'); assert.equal(saved.recordType, 'schedule');
  assert.equal(page.get('notice-dialog').open, false);
  assert.equal(page.ui.state.selected, 'notice:fixture-id');
  assert.equal(page.ui.state.repeat, 'all'); assert.equal(page.ui.state.category, ''); assert.equal(page.ui.state.query, '');
});

test('日期可以没有时分和原文，时间事项名称留空时采用父事件标题', async () => {
  const data = snapshot(), page = browser(data); await flush(); await page.activate('add-notice');
  page.field('title').value = '项目交流'; page.field('participation').checked = true;
  page.get('event-fields').children[0].data.date = '2026-10-21';
  await page.submit();
  const saved = page.calls.find(call => call.method === 'POST').body.notices[0];
  assert.equal(saved.content, ''); assert.equal(saved.participation, 'planned');
  assert.equal(saved.events[0].title, '项目交流'); assert.equal(saved.events[0].date, '2026-10-21');
  assert.equal(saved.events[0].time, ''); assert.equal(saved.events[0].endTime, '');
});

test('课程与事件类型和重复方式分别筛选，一次性课程仍属于课程', async () => {
  const data = snapshot();
  data.eventRules.push({ ...clone(course), id: 'exercise', title: '每周锻炼', recordType: 'schedule', category: '日程' });
  data.eventRules.push({ ...clone(course), id: 'one-course', title: '实验补课', recurrence: null });
  const page = browser(data); await flush();
  await page.change('inbox-type', 'course');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id).sort()), ['one-course', 'shared-id']);
  await page.change('inbox-repeat', 'once');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['one-course']);
  await page.change('inbox-repeat', 'recurring');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['shared-id']);
  await page.change('inbox-type', 'event');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['exercise']);
  await page.change('inbox-repeat', 'once');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.key).sort()), ['event:once', 'notice:shared-id']);
});

test('统一表单切换课程时跟随默认分类，自定义分类和重复规则独立保留', async () => {
  const data = snapshot(); data.scheduleCategory = '个人安排'; data.courseCategory = '学期课程'; data.categories.push('个人安排', '学期课程', '科研');
  const page = browser(data); await flush();
  await page.planner.newEvent(undefined, undefined, 'course');
  assert.equal(page.field('category').value, '学期课程'); assert.equal(page.field('recordType').value, 'course');
  assert.equal(page.field('participation').checked, true);
  assert.ok(page.get('event-fields').children[0].data.recurrence);
  await page.changeType('schedule');
  assert.equal(page.field('category').value, '其他通知');
  assert.ok(page.get('event-fields').children[0].data.recurrence);
  page.field('category').value = '科研'; await page.changeType('course');
  assert.equal(page.field('category').value, '科研');
});

test('旧原文中的多个时间事项和根截止日期完整保留，可单独改一项为每周重复', async () => {
  const data = snapshot(); Object.assign(data.notices[0], { deadline: '2026-10-30', sourceName: '学院', events: [
    { title: '项目交流', date: '2026-10-21', time: '14:00', endTime: '15:00', kind: 'event', evidence: '每周三交流' },
    { title: '汇报答辩', date: '2026-10-28', time: '', kind: 'event', evidence: '28 日答辩' },
  ] });
  const page = browser(data); await flush(); await page.click({ action: 'edit', id: notice.id });
  assert.equal(page.get('event-fields').children.length, 3);
  const recurrence = { until: '2026-12-30', weekdays: [3], intervalWeeks: 1, weeks: [1, 2, 3], excludeDates: ['2026-11-04'] };
  page.get('event-fields').children[0].data.recurrence = recurrence;
  await page.submit();
  const saved = page.calls.find(call => call.method === 'PATCH').body;
  assert.equal(saved.id, notice.id); assert.equal(saved.patch.content, notice.content); assert.equal(saved.patch.sourceName, '学院');
  assert.equal(saved.patch.deadline, '2026-10-30'); assert.equal(saved.patch.events.length, 2);
  assert.deepEqual(saved.patch.events[0].recurrence, recurrence); assert.equal(saved.patch.events[0].evidence, '每周三交流');
  assert.equal(saved.patch.events[1].date, '2026-10-28'); assert.equal(saved.patch.events[1].time, '');
  assert.equal(saved.patch.participation, 'reference');
});

test('把旧根截止事项改为周期后移除根一次性截止，避免时间表重复展开', async () => {
  const data = snapshot(); data.notices[0].deadline = '2026-10-30';
  const page = browser(data); await flush(); await page.ui.openForm(notice.id);
  const row = page.get('event-fields').children[0]; assert.equal(row.dataset.legacyDeadline, 'true');
  row.data.recurrence = { until: '2026-12-25', weekdays: [5], intervalWeeks: 1, weeks: [], excludeDates: [] };
  await page.submit();
  const saved = page.calls.find(call => call.method === 'PATCH').body.patch;
  assert.equal(saved.deadline, ''); assert.ok(saved.events[0].recurrence);
});

test('既有个人事件经统一表单实时读版本并原编号保存，来源和参与状态可编辑', async () => {
  const data = snapshot(), latest = { ...clone(course), title: '最新课程', version: 8, date: '2026-10-19', sourceUrl: 'https://example.test/course', notes: '现有说明', sourceText: '课表原文', participation: 'planned', recurrence: { until: '2027-01-01', weekdays: [1], intervalWeeks: 1, weeks: [], excludeDates: [] } };
  const page = browser(data, call => call.path === '/api/event-rules' ? { body: { events: [latest] } } : store(call, data)); await flush();
  await page.click({ action: 'edit-rule', id: course.id });
  assert.equal(page.field('title').value, '最新课程'); assert.equal(page.field('content').value, '课表原文');
  assert.equal(page.field('sourceUrl').value, latest.sourceUrl); assert.equal(page.get('add-event').hidden, true);
  page.field('title').value = '改名后的课程'; page.field('participation').checked = false;
  await page.submit();
  const saved = page.calls.find(call => call.method === 'PATCH');
  assert.equal(saved.path, '/api/events'); assert.equal(saved.body.id, course.id); assert.equal(saved.body.expectedVersion, 8);
  assert.equal(saved.body.patch.title, '改名后的课程'); assert.equal(saved.body.patch.sourceText, '课表原文');
  assert.equal(saved.body.patch.participation, 'reference'); assert.deepEqual(saved.body.patch.recurrence, latest.recurrence);
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0);
});

test('调课子项的类型、分类和参与状态禁止独立更改，保存采用读取到的父系属性', async () => {
  const data = snapshot(), moved = { ...clone(course), id: 'moved', seriesId: course.id, recurrence: null, version: 7, date: '2026-10-22', participation: 'reference' };
  const page = browser(data, call => {
    if (call.path === '/api/event-rules') return { body: { events: [moved] } };
    if (call.path === '/api/events') return { body: { event: moved } };
    return store(call, data);
  }); await flush(); await page.planner.openEvent(moved.id);
  for (const name of ['recordType', 'category', 'participation']) assert.equal(page.field(name).disabled, true);
  page.field('recordType').value = 'schedule'; page.field('category').value = '校园事务'; page.field('participation').checked = true;
  page.get('event-fields').children[0].data.time = '10:00';
  page.get('event-fields').children[0].data.endTime = '11:40';
  await page.submit();
  const saved = page.calls.find(call => call.method === 'PATCH').body;
  assert.equal(saved.expectedVersion, 7); assert.equal(saved.patch.recordType, 'course');
  assert.equal(saved.patch.category, '课程'); assert.equal(saved.patch.participation, 'reference'); assert.equal(saved.patch.time, '10:00');
});

test('没有日期就填写时间时显示保存错误，并保留原输入供修正', async () => {
  const page = browser(snapshot()); await flush(); await page.activate('add-notice');
  page.field('title').value = '待核对日期'; page.get('event-fields').children[0].data.time = '10:00';
  await page.submit();
  assert.equal(page.calls.filter(call => call.method !== 'GET').length, 0);
  assert.equal(page.get('notice-dialog').open, true); assert.equal(page.get('event-form-error').hidden, false);
  assert.match(page.get('event-form-error').textContent, /开始日期/);
  assert.equal(page.get('event-fields').children[0].data.time, '10:00');
});

test('旧一次性安排清除日期后仍以原编号保存为待定事件', async () => {
  const data = snapshot(), latest = { ...clone(course), id: 'once', date: '2026-10-21', title: '待确认讨论', recurrence: null, version: 4 };
  const page = browser(data, call => call.path === '/api/event-rules' ? { body: { events: [latest] } } : store(call, data)); await flush();
  await page.planner.openEvent(latest.id);
  Object.assign(page.get('event-fields').children[0].data, { date: '', time: '', endDate: '', endTime: '' });
  await page.submit();
  const saved = page.calls.find(call => call.method === 'PATCH');
  assert.equal(saved.path, '/api/events'); assert.equal(saved.body.id, latest.id); assert.equal(saved.body.expectedVersion, 4);
  assert.equal(saved.body.patch.date, ''); assert.equal(saved.body.patch.recurrence, null);
  assert.equal(page.get('notice-dialog').open, false);
});

test('编辑时分类被删除会保留表单并提示重新选择，不静默改到其他分类', async () => {
  const data = snapshot(), page = browser(data); await flush(); await page.ui.openForm(notice.id);
  data.categories = data.categories.filter(category => category !== '校园事务');
  await page.ui.refresh(); await page.submit();
  assert.equal(page.calls.filter(call => call.method !== 'GET').length, 0);
  assert.equal(page.get('notice-dialog').open, true); assert.match(page.get('event-form-error').textContent, /分类已变更/);
});

test('普通事件编辑读取最新时间戳，保存遇到409时保留表单和Agent新内容', async () => {
  const data = snapshot(); let gets = 0;
  const page = browser(data, call => {
    if (call.path === '/api/notices' && call.method === 'GET') {
      if (++gets === 2) Object.assign(data.notices[0], { updatedAt: 5, title: 'Agent 更新的标题' });
      return { body: data };
    }
    assert.equal(call.method, 'PATCH'); assert.equal(call.body.expectedUpdatedAt, 5);
    return { status: 409, body: { error: '事件已被更新，请重新打开后核对。' } };
  }); await flush(); await page.ui.openForm(notice.id);
  assert.equal(page.field('title').value, 'Agent 更新的标题');
  page.field('title').value = '用户正在编辑的标题';
  Object.assign(data.notices[0], { updatedAt: 6, content: 'Agent 随后写入的新原文' });
  await page.submit();
  assert.equal(page.get('notice-dialog').open, true); assert.equal(page.get('event-form-error').hidden, false);
  assert.match(page.get('event-form-error').textContent, /已被更新/); assert.equal(page.field('title').value, '用户正在编辑的标题');
  assert.equal(data.notices[0].updatedAt, 6); assert.equal(data.notices[0].content, 'Agent 随后写入的新原文');
});

test('下一次时间排序与即将截止共同使用周期展开，原文事件和个人规则均不采用旧锚点', async () => {
  const recurrence = { until: '2026-11-01', weekdays: [5], intervalWeeks: 1, weeks: [], excludeDates: [] };
  const data = snapshot();
  data.notices = [
    { ...clone(notice), id: 'weekly-info', title: '每周资料提交', deadline: '2026-09-07', events: [{ title: '提交材料', kind: 'deadline', date: '2026-09-07', recurrence }] },
    { ...clone(notice), id: 'earlier', title: '明天的活动', deadline: '', createdAt: 3, events: [{ title: '项目说明', kind: 'event', date: '2026-10-21' }] },
  ];
  data.eventRules = [{ ...clone(course), id: 'weekly-plan', title: '每周计划截止', recordType: 'schedule', kind: 'deadline', category: '日程', time: '', endTime: '', date: '2026-09-07', recurrence: { ...recurrence, weekdays: [4] }, nextOccurrence: { date: '2026-10-22' } }];
  const page = browser(data); await flush();
  await page.change('sort', 'next');
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['earlier', 'weekly-plan', 'weekly-info']);
  const weeklyInfo = page.ui.entries().find(entry => entry.id === 'weekly-info');
  const weeklyPlan = page.ui.entries().find(entry => entry.id === 'weekly-plan');
  assert.equal(page.ui.entryDate(weeklyInfo), '2026-10-23'); assert.equal(page.ui.entryDeadline(weeklyInfo), '2026-10-23');
  assert.equal(page.ui.entryDate(weeklyPlan), '2026-10-22'); assert.equal(page.ui.entryDeadline(weeklyPlan), '2026-10-22');
  await page.click({ view: 'soon' });
  assert.deepEqual(clone(page.ui.filtered().map(entry => entry.id)), ['weekly-plan', 'weekly-info']);
});

test('只填了名称和依据的待定时间事项可保留，并继续留空日期', async () => {
  const data = snapshot(), page = browser(data); await flush(); await page.activate('add-notice');
  page.field('title').value = '待确认的项目安排';
  Object.assign(page.get('event-fields').children[0].data, { title: '答辩', evidence: '日期另行公布' });
  await page.submit();
  const saved = page.calls.find(call => call.method === 'POST').body.notices[0];
  assert.equal(saved.events.length, 1); assert.equal(saved.events[0].title, '答辩');
  assert.equal(saved.events[0].date, ''); assert.equal(saved.events[0].evidence, '日期另行公布');
});

test('默认与自定义分类的色点和事件卡片一致，新增分类不会改变已有颜色', async () => {
  const data = snapshot(); data.categories.push('科研', '社团');
  data.notices.push({ ...notice, id: 'research', category: '科研', title: '研究计划' });
  const page = browser(data); await flush();
  const color = page.ui.categoryStyle('科研').color;
  assert.notEqual(color, page.ui.categoryStyle('社团').color);
  assert.notEqual(page.ui.categoryStyle('课程').color, page.ui.categoryStyle('日程').color);
  assert.ok(page.get('category-nav').innerHTML.includes(`background:${color}`));
  assert.ok(page.get('notice-list').innerHTML.includes(`--category-color:${color}`));
  data.categories.push('旅行'); await page.ui.refresh();
  assert.equal(page.ui.categoryStyle('科研').color, color);
  assert.ok(page.get('notice-list').innerHTML.includes(`--category-color:${page.ui.categoryStyle('课程').color}`));
});
