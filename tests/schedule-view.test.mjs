import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { normalizeEvents } from '../lib/notice-input.ts';

const context = { Intl, Date };
runInNewContext(readFileSync(new URL('../public/event-rules.js', import.meta.url), 'utf8'), context);
runInNewContext(readFileSync(new URL('../public/schedule.js', import.meta.url), 'utf8'), context);
const schedule = context.ZhihuiSchedule;
const plain = value => JSON.parse(JSON.stringify(value));
const event = (changes = {}) => ({ title: '测试活动', date: '2026-10-21', ...changes });
const notice = (changes = {}) => ({ id: 'fixture-id', title: '测试通知', category: '校园活动', content: '自编测试原文。', deadline: '', events: [], ...changes });

test('前端与服务端接受相同的事件结构，未知时分保持为空', () => {
  const values = [event(), event({ time: '09:00', endTime: '10:00' }), event({ time: '23:00', endDate: '2026-10-22', endTime: '01:00' }), event({ kind: 'deadline', time: '19:00' }), event({ date: '', evidence: '日期待定' })];
  assert.deepEqual(plain(schedule.normalizeEvents(values)), normalizeEvents(values));
  for (const invalid of [null, 'wrong', Array(51).fill(event())]) {
    assert.throws(() => schedule.normalizeEvents(invalid)); assert.throws(() => normalizeEvents(invalid));
  }
  for (const invalid of [{ date: '2026-02-30' }, { date: '', time: '09:00' }, { time: '24:00' }, { endTime: '10:00' }, { time: '12:00', endTime: '11:00' }, { endDate: '2026-10-20' }, { kind: null }, { kind: 'deadline', endDate: '2026-10-22' }]) {
    assert.throws(() => schedule.normalizeEvents([event(invalid)])); assert.throws(() => normalizeEvents([event(invalid)]));
  }
});

test('任意起止日期均含当天，跨区间活动保留真实起止并标明进行中', () => {
  const input = [notice({ events: [event({ date: '2026-10-18', endDate: '2026-10-22' }), event({ title: '最后一天', date: '2026-10-25' }), event({ title: '窗口以外', date: '2026-10-26' })] })];
  const result = schedule.collect(input, '2026-10-19', '2026-10-25');
  assert.equal(result.length, 2);
  assert.equal(result[0].date, '2026-10-18'); assert.equal(result[0].displayDate, '2026-10-19'); assert.equal(result[0].ongoing, true);
  assert.equal(schedule.collect(input, '2026-10-22', '2026-10-22').length, 1);
  assert.equal(schedule.collect(input, '2026-10-23', '2026-10-24').length, 0);
  assert.equal(schedule.collect([notice({ events: [event({ date: '', evidence: '待确认' })] })], '2026-10-19', '2026-10-25').length, 0);
});

test('旧截止日期直接进入时间表；同日明确截止时间避免重复，类型筛选独立', () => {
  const legacy = notice({ id: 'old', deadline: '2026-10-21', events: undefined });
  const modern = notice({ id: 'modern', deadline: '2026-10-21', events: normalizeEvents([event({ kind: 'deadline', time: '19:00' }), event({ time: '14:00' })]) });
  const result = schedule.collect([legacy, modern, notice({ id: 'undated' })], '2026-10-19', '2026-10-25');
  assert.equal(result.length, 3);
  assert.deepEqual(plain(result.map(event => event.time)), ['14:00', '19:00', '']);
  assert.equal(schedule.collect([legacy, modern], '2026-10-19', '2026-10-25', 'event').length, 1);
  assert.equal(schedule.collect([legacy, modern], '2026-10-19', '2026-10-25', 'deadline').length, 2);
  assert.equal(result.find(event => event.noticeId === 'old').kind, 'deadline');
});

test('日期窗口拒绝反向及非法日期，北京时间跨午夜计算正确', () => {
  for (const [from, to] of [['2026-10-22', '2026-10-21'], ['2026-02-30', '2026-03-03'], ['', '2026-10-21']]) assert.throws(() => schedule.collect([], from, to));
  const clock = { Intl, Date: class extends Date { constructor(...args) { super(...(args.length ? args : ['2026-10-19T17:00:00Z'])); } } };
  runInNewContext(readFileSync(new URL('../public/schedule.js', import.meta.url), 'utf8'), clock);
  assert.equal(clock.ZhihuiSchedule.today(), '2026-10-20');
  assert.equal(schedule.shiftDay('2026-12-29', 6), '2027-01-04');
});

test('同一事件保留多个时间点，周期节点按区间展开，参考信息不占用个人时间', () => {
  const recurring = event({ date: '2026-10-19', recurrence: { until: '2026-11-02', weekdays: [1], excludeDates: ['2026-10-26'] }, evidence: '每周一，10月26日跳过。' });
  const input = [notice({ events: [recurring, event({ title: '只发生一次', date: '2026-10-21' })] })];
  assert.deepEqual(plain(schedule.normalizeEvents(input[0].events)), normalizeEvents(input[0].events));
  const result = schedule.collect(input, '2026-10-19', '2026-11-02');
  assert.deepEqual(plain(result.map(value => value.date)), ['2026-10-19', '2026-10-21', '2026-11-02']);
  assert.equal(result[0].eventType, 'recurring'); assert.equal(result[0].evidence, recurring.evidence);
  assert.ok(result.every(value => value.participation === 'reference' && value.occupiesTime === false && value.sourceType === 'notice'));
  assert.equal(schedule.collect([{ ...input[0], active: false }], '2026-10-19', '2026-11-02').length, 0);
  assert.ok(schedule.collect([{ ...input[0], participation: 'planned', recordType: 'course' }], '2026-10-19', '2026-11-02').every(value => value.occupiesTime && value.recordType === 'course'));
  for (const rule of [{ until: '', weekdays: [1] }, { until: '2026-11-02', weekdays: [] }, { until: '2026-11-02', weekdays: [1], weeks: [0] }]) {
    assert.throws(() => schedule.normalizeEvents([event({ recurrence: rule })]));
    assert.throws(() => normalizeEvents([event({ recurrence: rule })]));
  }
});
