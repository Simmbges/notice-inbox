'use strict';

globalThis.ZhihuiEventRules = (() => {
  const day = 86400000;
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * day).toISOString().slice(0, 10);
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  function checkRange(from, to) {
    if (!validDate(from) || !validDate(to) || from > to) throw new Error('请选择有效的起止日期，结束日期不能早于开始日期。');
    if ((Date.parse(to) - Date.parse(from)) / day >= 366) throw new Error('单次查询最多支持 366 天，请缩小日期范围。');
  }
  function normalizeEvent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('事件必须是一个对象。');
    const event = {};
    for (const [key, max] of Object.entries({ id: 160, title: 120, date: 10, time: 5, endDate: 10, endTime: 5, evidence: 500, location: 120, notes: 20000, sourceName: 80, sourceText: 20000, sourceUrl: 2000, noticeId: 160, category: 30 })) {
      if (raw[key] !== undefined && typeof raw[key] !== 'string') throw new Error(`${key} 必须为文本。`);
      event[key] = (raw[key] || '').trim();
      if (event[key].length > max) throw new Error(`${key} 最多 ${max} 个字符。`);
    }
    if (!event.title || event.date && !validDate(event.date) || event.endDate && !validDate(event.endDate)) throw new Error('事件需要标题，日期须为有效的 YYYY-MM-DD，未知日期请留空。');
    if (!event.date && (event.time || event.endDate || event.endTime || raw.recurrence !== undefined && raw.recurrence !== null)) throw new Error('填写时间范围或周期规则前，需要有效的开始日期。');
    if (event.sourceUrl) {
      try { const url = new URL(event.sourceUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); event.sourceUrl = url.href; }
      catch { throw new Error('原文链接仅支持 HTTP 或 HTTPS。'); }
    }
    if (![event.time, event.endTime].every(value => !value || /^([01]\d|2[0-3]):[0-5]\d$/.test(value))) throw new Error('时间必须为有效的 HH:mm，未知时间请留空。');
    event.kind = raw.kind === undefined ? 'event' : raw.kind;
    if (!['event', 'deadline'].includes(event.kind)) throw new Error('kind 只支持 event 或 deadline。');
    event.recordType = raw.recordType === undefined ? 'schedule' : raw.recordType;
    if (!['schedule', 'course'].includes(event.recordType)) throw new Error('recordType 只支持 schedule（日程）或 course（课程）。');
    event.participation = raw.participation === undefined ? 'planned' : raw.participation;
    if (!['reference', 'planned'].includes(event.participation)) throw new Error('participation 只支持 reference（参考信息）或 planned（已安排）。');
    if (event.kind === 'deadline' && (event.endDate || event.endTime)) throw new Error('截止事项不能填写结束日期或结束时间。');
    if (event.endDate && event.endDate < event.date || event.endTime && (!event.time || `${event.endDate || event.date}T${event.endTime}` <= `${event.date}T${event.time}`)) throw new Error('结束时间需要开始时间，且必须晚于开始时间。');
    if (raw.active !== undefined && typeof raw.active !== 'boolean') throw new Error('active 必须为布尔值。');
    if (raw.favorite !== undefined && typeof raw.favorite !== 'boolean') throw new Error('favorite 必须为布尔值。');
    event.active = raw.active !== false;
    event.favorite = raw.favorite === true;
    event.recurrence = null;
    if (raw.recurrence !== undefined && raw.recurrence !== null) {
      const rule = raw.recurrence;
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new Error('周期规则必须是一个对象。');
      if (Object.keys(rule).some(key => !['until', 'weekdays', 'intervalWeeks', 'weeks', 'excludeDates'].includes(key))) throw new Error('周期规则含有不支持的字段。');
      if (!validDate(rule.until) || rule.until < event.date) throw new Error('周期结束日期必须有效，且不早于开始日期。');
      const years = Number(rule.until.slice(0, 4)) - Number(event.date.slice(0, 4));
      if (years > 5 || years === 5 && rule.until.slice(5) > event.date.slice(5)) throw new Error('周期最多跨度 5 年。');
      const numbers = (value, min, max, label, required = false) => {
        if (!Array.isArray(value) || value.length > max || required && !value.length || value.some(item => !Number.isInteger(item) || item < min || item > max)) throw new Error(`${label}必须是 ${min}—${max} 的整数数组${required ? '且不能为空' : ''}。`);
        return [...new Set(value)].sort((a, b) => a - b);
      };
      const intervalWeeks = rule.intervalWeeks === undefined ? 1 : rule.intervalWeeks;
      if (!Number.isInteger(intervalWeeks) || intervalWeeks < 1 || intervalWeeks > 52) throw new Error('周间隔必须是 1—52 的整数。');
      if (event.endDate && event.endDate !== event.date) throw new Error('每周周期事件只支持同一天的时间范围。');
      const excludeDates = rule.excludeDates === undefined ? [] : rule.excludeDates;
      if (!Array.isArray(excludeDates) || excludeDates.length > 1831 || excludeDates.some(value => !validDate(value))) throw new Error('排除日期必须是有效日期数组，最多 1831 项。');
      event.recurrence = { until: rule.until, weekdays: numbers(rule.weekdays, 1, 7, '每周星期', true), intervalWeeks, weeks: numbers(rule.weeks === undefined ? [] : rule.weeks, 1, 60, '学期周次'), excludeDates: [...new Set(excludeDates)].sort() };
      event.endDate = '';
    }
    return event;
  }
  function expandEvent(input, from, to) {
    checkRange(from, to);
    const event = { ...input, ...normalizeEvent(input) };
    if (!event.active || !event.date) return [];
    const decorate = date => ({ ...event, id: `${event.id || 'event'}:${date}`, eventId: event.id, date, occurrenceDate: date, eventType: event.recurrence ? 'recurring' : 'once', displayDate: date < from ? from : date, ongoing: date < from });
    if (!event.recurrence) return event.date <= to && (event.endDate || event.date) >= from ? [decorate(event.date)] : [];
    const rule = event.recurrence;
    const start = event.date > from ? event.date : from, end = rule.until < to ? rule.until : to;
    const anchor = Date.parse(event.date) - ((new Date(event.date).getUTCDay() + 6) % 7) * day;
    const excluded = new Set(rule.excludeDates), selectedWeeks = new Set(rule.weeks), result = [];
    for (let timestamp = Date.parse(start); timestamp <= Date.parse(end); timestamp += day) {
      const date = new Date(timestamp).toISOString().slice(0, 10);
      const week = Math.floor((timestamp - anchor) / (7 * day)) + 1;
      const weekday = ((new Date(date).getUTCDay() + 6) % 7) + 1;
      if ((week - 1) % rule.intervalWeeks || selectedWeeks.size && !selectedWeeks.has(week) || !rule.weekdays.includes(weekday) || excluded.has(date)) continue;
      result.push(decorate(date));
    }
    return result;
  }
  return { normalizeEvent, expandEvent, checkRange, validDate, shiftDay, today };
})();
