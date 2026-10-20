'use strict';

globalThis.ZhihuiEventEditor = (() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const value = (row, key) => row.querySelector(`[data-event-field="${key}"]`).value.trim();
  const ruleValue = (row, key) => row.querySelector(`[data-rule-field="${key}"]`).value.trim();

  function fields(event = {}) {
    const recurring = !!event.recurrence, deadline = event.kind === 'deadline';
    const rule = event.recurrence || { until: '', weekdays: [], intervalWeeks: 1, weeks: [], excludeDates: [] };
    const input = (key, type, label, extra = '') => `<label class="field"><span data-event-label="${key}">${label}</span><input data-event-field="${key}" type="${type}" value="${esc(event[key])}" ${extra}></label>`;
    const ruleInput = (key, type, label, initial, extra = '') => `<label class="field">${label}<input data-rule-field="${key}" type="${type}" value="${esc(initial)}" ${extra}></label>`;
    return `<div class="event-field-row event-time-card"><div class="event-row-heading"><div class="field-row"><label class="field">重复方式<select data-repeat aria-label="重复方式"><option value="once" ${!recurring ? 'selected' : ''}>不重复</option><option value="recurring" ${recurring ? 'selected' : ''}>每周重复</option></select></label><label class="field">时间类型<select data-event-field="kind" aria-label="时间类型"><option value="event" ${!deadline ? 'selected' : ''}>活动</option><option value="deadline" ${deadline ? 'selected' : ''}>截止事项</option></select></label></div><button type="button" class="text-button remove-event" data-remove-event>移除此时间</button></div>${input('title', 'text', '时间事项名称（可选）', 'maxlength="120" placeholder="留空则使用事件标题"')}<div class="field-row">${input('date', 'date', deadline ? '截止日期（可选）' : '开始日期（可选）', recurring ? 'required' : '')}${input('time', 'time', deadline ? '截止时间（可选）' : '开始时间（可选）')}</div><div class="field-row event-end"><div data-end-date ${recurring || deadline ? 'hidden' : ''}>${input('endDate', 'date', '结束日期（可选）')}</div><div data-end-time ${deadline ? 'hidden' : ''}>${input('endTime', 'time', '结束时间（可选）')}</div></div><fieldset data-recurrence class="event-editor" ${recurring ? '' : 'hidden disabled'}><legend>每周重复规则</legend>${ruleInput('until', 'date', '重复结束日期', rule.until, recurring ? 'required' : '')}<div class="event-rule-days">${weekdays.map((day, index) => `<label><input type="checkbox" data-rule-weekday value="${index + 1}" ${rule.weekdays.includes(index + 1) ? 'checked' : ''}>周${day}</label>`).join('')}</div><div class="field-row">${ruleInput('intervalWeeks', 'number', '每隔几周（1 表示每周）', rule.intervalWeeks ?? 1, 'min="1" max="52"')}${ruleInput('weeks', 'text', '指定周次（可选）', (rule.weeks || []).join(','), 'placeholder="例如：1-16 或 1,3,5,7"')}</div>${ruleInput('excludeDates', 'text', '跳过日期（可选，逗号分隔）', (rule.excludeDates || []).join(','), 'placeholder="2026-10-01,2026-10-02"')}<p class="event-rule-note">第 1 周从开始日期所在周的周一算起；不确定的日期和时间请先核对。</p></fieldset><details class="event-proof"><summary>日期依据或补充说明（可选）</summary><label class="field"><textarea data-event-field="evidence" aria-label="日期依据或补充说明" rows="2" maxlength="500" placeholder="可保留原文中提到日期和时间的句子。">${esc(event.evidence)}</textarea></label></details></div>`;
  }

  function weekNumbers(text) {
    const result = [];
    for (const token of text.replaceAll('，', ',').split(',').map(item => item.trim()).filter(Boolean)) {
      if (!/^\d+(?:\s*-\s*\d+)?$/.test(token)) throw new Error('周次请填写 1-16 或 1,3,5 这样的格式。');
      const [start, last] = token.split('-').map(Number), end = last ?? start;
      if (start < 1 || end > 60 || start > end) throw new Error('周次范围需要从小到大，且在第 1—60 周内。');
      for (let week = start; week <= end; week++) result.push(week);
    }
    return [...new Set(result)].sort((a, b) => a - b);
  }

  function read(row) {
    const event = Object.fromEntries(['title', 'date', 'time', 'endDate', 'endTime', 'kind', 'evidence'].map(key => [key, value(row, key)]));
    const recurring = row.querySelector('[data-repeat]').value === 'recurring';
    if (event.kind === 'deadline') { event.endDate = ''; event.endTime = ''; }
    if (recurring) event.endDate = '';
    if (!recurring && ['title', 'date', 'time', 'endDate', 'endTime', 'evidence'].every(key => !event[key])) return null;
    event.recurrence = recurring ? {
      until: ruleValue(row, 'until'),
      weekdays: [...row.querySelectorAll('[data-rule-weekday]:checked')].map(input => Number(input.value)),
      intervalWeeks: Number(ruleValue(row, 'intervalWeeks')),
      weeks: weekNumbers(ruleValue(row, 'weeks')),
      excludeDates: ruleValue(row, 'excludeDates').replaceAll('，', ',').split(',').map(date => date.trim()).filter(Boolean),
    } : null;
    return event;
  }

  function sync(row) {
    const recurring = row.querySelector('[data-repeat]').value === 'recurring';
    const deadline = value(row, 'kind') === 'deadline';
    const fieldset = row.querySelector('[data-recurrence]');
    fieldset.hidden = !recurring; fieldset.disabled = !recurring;
    row.querySelector('[data-rule-field="until"]').required = recurring;
    row.querySelector('[data-event-field="date"]').required = recurring;
    row.querySelector('[data-event-label="date"]').textContent = recurring ? '重复开始日期' : deadline ? '截止日期（可选）' : '开始日期（可选）';
    row.querySelector('[data-event-label="time"]').textContent = deadline ? '截止时间（可选）' : '开始时间（可选）';
    row.querySelector('[data-end-date]').hidden = recurring || deadline;
    row.querySelector('[data-end-time]').hidden = deadline;
    row.querySelector('.event-end').hidden = deadline;
    row.querySelector('[data-event-field="endDate"]').disabled = recurring || deadline;
    row.querySelector('[data-event-field="endTime"]').disabled = deadline;
  }

  function hydrate(root = document) {
    if (root.matches?.('.event-field-row')) sync(root);
    else root.querySelectorAll('.event-field-row').forEach(sync);
  }
  document.addEventListener('change', event => {
    if (!event.target.matches('[data-repeat], [data-event-field="kind"]')) return;
    const row = event.target.closest('.event-field-row');
    if (row) sync(row);
  });
  return { fields, read, sync, hydrate };
})();
