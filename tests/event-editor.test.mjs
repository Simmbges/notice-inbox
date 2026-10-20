import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const script = readFileSync(new URL('../public/event-editor.js', import.meta.url), 'utf8');
function editor() {
  const listeners = new Map();
  const context = { document: { addEventListener(type, listener) { listeners.set(type, listener); } } };
  runInNewContext(script, context);
  return { ...context.ZhihuiEventEditor, change: target => listeners.get('change')({ target }) };
}
const plain = value => JSON.parse(JSON.stringify(value));
function row(values = {}, rule = {}, recurring = false) {
  const elements = new Map();
  for (const key of ['title', 'date', 'time', 'endDate', 'endTime', 'kind', 'evidence']) elements.set(`[data-event-field="${key}"]`, { value: values[key] || (key === 'kind' ? 'event' : '') });
  for (const key of ['until', 'intervalWeeks', 'weeks', 'excludeDates']) elements.set(`[data-rule-field="${key}"]`, { value: rule[key] ?? (key === 'intervalWeeks' ? '1' : '') });
  for (const selector of ['[data-recurrence]', '[data-end-date]', '[data-end-time]', '.event-end', '[data-event-label="date"]', '[data-event-label="time"]']) elements.set(selector, {});
  elements.set('[data-repeat]', { value: recurring ? 'recurring' : 'once' });
  const result = {
    querySelector: selector => elements.get(selector),
    querySelectorAll: selector => selector === '[data-rule-weekday]:checked' ? (rule.weekdays || []).map(value => ({ value: String(value) })) : [],
    matches: selector => selector === '.event-field-row',
  };
  return result;
}

test('空白可选时间卡忽略；只写名称或时间时保留输入供主表单验证', () => {
  const api = editor();
  assert.equal(api.read(row()), null);
  assert.equal(api.read(row({ title: ' 报名截止 ' })).title, '报名截止');
  assert.equal(api.read(row({ time: '10:30' })).time, '10:30');
  const html = api.fields();
  assert.doesNotMatch(html, /data-event-field="date"[^>]*required/);
  assert.doesNotMatch(html, /data-event-field="title"[^>]*required/);
  assert.match(html, /type="button"[^>]*data-remove-event/);
});

test('周期规则读取周次范围、重复星期与原有例外，不猜起算日期', () => {
  const api = editor();
  const data = api.read(row({ title: '高等数学', endDate: '2026-10-21' }, { until: '2027-01-01', weekdays: [1, 3], weeks: '1-3， 5,3', intervalWeeks: '2', excludeDates: '2026-10-01， 2026-10-02' }, true));
  assert.equal(data.date, ''); assert.equal(data.endDate, '');
  assert.deepEqual(plain(data.recurrence), { until: '2027-01-01', weekdays: [1, 3], intervalWeeks: 2, weeks: [1, 2, 3, 5], excludeDates: ['2026-10-01', '2026-10-02'] });
  for (const weeks of ['16-1', '0', '1-99999999', '1.5', '1,a']) assert.throws(() => api.read(row({}, { weeks }, true)), /周次/);
});

test('切换截止事项只隐藏结束时间，切回活动时仍保留未提交输入', () => {
  const api = editor(), card = row({ date: '2026-10-20', time: '10:00', endDate: '2026-10-21', endTime: '12:00', evidence: '原文依据' });
  card.querySelector('[data-event-field="kind"]').value = 'deadline'; api.sync(card);
  assert.equal(card.querySelector('.event-end').hidden, true);
  assert.equal(api.read(card).endDate, ''); assert.equal(api.read(card).endTime, '');
  assert.equal(card.querySelector('[data-event-field="endDate"]').value, '2026-10-21');
  card.querySelector('[data-event-field="kind"]').value = 'event'; api.sync(card);
  assert.equal(card.querySelector('.event-end').hidden, false);
  assert.equal(api.read(card).endDate, '2026-10-21'); assert.equal(api.read(card).endTime, '12:00');
  assert.equal(api.read(card).evidence, '原文依据');
});

test('切换重复方式保留规则输入，一次性保存不提交旧周期规则', () => {
  const api = editor(), card = row({ date: '2026-10-20' }, { until: '2027-01-01', weekdays: [2], weeks: '1-16', intervalWeeks: '1' }, true);
  api.hydrate(card);
  assert.equal(card.querySelector('[data-recurrence]').hidden, false);
  assert.equal(card.querySelector('[data-event-field="date"]').required, true);
  assert.equal(card.querySelector('[data-rule-field="until"]').required, true);
  card.querySelector('[data-repeat]').value = 'once'; api.sync(card);
  assert.equal(card.querySelector('[data-recurrence]').disabled, true);
  assert.equal(card.querySelector('[data-event-field="date"]').required, false);
  assert.equal(api.read(card).recurrence, null);
  card.querySelector('[data-repeat]').value = 'recurring'; api.sync(card);
  assert.deepEqual(plain(api.read(card).recurrence.weeks), Array.from({ length: 16 }, (_, index) => index + 1));
});

test('字段回填完整周期和依据，恶意文字仅作为转义文本', () => {
  const html = editor().fields({ title: '"><script>bad()</script>', evidence: '</textarea><img src=x onerror=bad()>', recurrence: { until: '2027-01-01', weekdays: [1, 7], intervalWeeks: 2, weeks: [1, 3], excludeDates: ['2026-10-01'] } });
  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/); assert.match(html, /&lt;\/textarea&gt;/);
  assert.match(html, /data-rule-field="weeks"[^>]*value="1,3"/);
  assert.match(html, /data-rule-field="excludeDates"[^>]*value="2026-10-01"/);
  assert.match(html, /data-rule-weekday value="7" checked/);
});

test('委托监听只处理所属时间卡的重复和类型变化', () => {
  const api = editor(), card = row({}, {}, true);
  api.change({ matches: () => true, closest: () => card });
  assert.equal(card.querySelector('[data-recurrence]').hidden, false);
  assert.doesNotThrow(() => api.change({ matches: () => false }));
});
