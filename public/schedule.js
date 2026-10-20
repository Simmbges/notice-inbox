'use strict';

globalThis.ZhihuiSchedule = (() => {
  const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const shiftDay = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  function normalizeEvents(values = []) {
    if (!Array.isArray(values) || values.length > 50) throw new Error('每条事件最多记录 50 个时间事项。');
    return values.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('事件格式不正确。');
      const keys = ['title', 'date', 'time', 'endDate', 'endTime', 'kind', 'evidence', 'recurrence'];
      const normalized = globalThis.ZhihuiEventRules.normalizeEvent(Object.fromEntries(keys.filter(key => raw[key] !== undefined).map(key => [key, raw[key]])));
      const event = Object.fromEntries(keys.filter(key => key !== 'recurrence').map(key => [key, normalized[key]]));
      if (raw.recurrence !== undefined) event.recurrence = normalized.recurrence;
      return event;
    });
  }
  function collect(notices, from, to, kind = 'all') {
    globalThis.ZhihuiEventRules.checkRange(from, to);
    const result = [];
    for (const notice of notices) {
      if (notice.active === false) continue;
      const events = [...(notice.events || [])];
      if (notice.deadline && !events.some(event => event.kind === 'deadline' && event.date === notice.deadline)) {
        events.push({ title: notice.title, date: notice.deadline, time: '', endDate: '', endTime: '', kind: 'deadline', evidence: '' });
      }
      for (const [index, event] of events.entries()) {
        const participation = notice.participation || 'reference';
        for (const occurrence of globalThis.ZhihuiEventRules.expandEvent({ ...event, id: `${notice.id}:${index}`, participation, recordType: notice.recordType || 'schedule' }, from, to)) {
          if (kind !== 'all' && occurrence.kind !== kind) continue;
          result.push({ ...occurrence, id: `notice:${notice.id}:${index}:${occurrence.occurrenceDate}`, sourceType: 'notice', noticeId: notice.id, noticeTitle: notice.title, category: notice.category, sourceName: notice.sourceName, location: notice.location, participation, occupiesTime: participation === 'planned' && occurrence.kind === 'event' });
        }
      }
    }
    return result.sort((a, b) => a.displayDate.localeCompare(b.displayDate) || Number(b.ongoing) - Number(a.ongoing) || (a.time || '99:99').localeCompare(b.time || '99:99') || a.title.localeCompare(b.title, 'zh-CN'));
  }
  return { today, shiftDay, normalizeEvents, collect };
})();
