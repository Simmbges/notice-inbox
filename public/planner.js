'use strict';

globalThis.ZhihuiPlanner = (() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const rules = globalThis.ZhihuiEventRules;
  const statusText = { todo: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' };
  const priorityText = { high: '高', normal: '普通', low: '低' };
  const weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  let categoryNames = ['日程', '课程'];
  let defaultCategories = { schedule: '日程', course: '课程' }, eventEditor;
  let view = '', eventType = 'once', showInactive = false, taskStatus = 'all', tasks = [], events = [], preferences, editing = null, busyView = '', refreshGeneration = 0, viewGeneration = 0, reviewGeneration = 0, drawnView = '', reviewSignature = '';
  const host = () => $('planner-section');
  function message(text) { document.dispatchEvent(new CustomEvent('planner:message', { detail: text })); }
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (response.status === 401) { location.assign('/login'); throw new Error('请重新登录。'); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败，请重试。');
    return result;
  }
  const field = (name, label, value = '', type = 'text', extra = '') => `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`;
  const select = (name, label, value, options, extra = '') => `<label class="field">${label}<select name="${name}" ${extra}>${Object.entries(options).map(([key, text]) => `<option value="${esc(key)}" ${key === value ? 'selected' : ''}>${esc(text)}</option>`).join('')}</select></label>`;
  const area = (name, label, value, max = 4000) => `<label class="field">${label}<textarea name="${name}" maxlength="${max}" rows="3">${esc(value || '')}</textarea></label>`;
  const heading = (title, intro, action = '') => `<div class="section-heading"><h2>${title}</h2>${action}</div><p class="planner-intro">${intro}</p>`;
  const empty = text => `<div class="planner-empty">${esc(text)}</div>`;
  const taskCard = task => `<article class="task-card ${task.status === 'done' ? 'task-done' : ''}"><div class="task-card-main"><button type="button" data-planner="edit-task" data-id="${esc(task.id)}" class="planner-title">${esc(task.title)}</button><p>${esc(task.notes || '暂无补充说明')}</p><div class="planner-meta"><span class="priority-${task.priority}">${priorityText[task.priority]}优先级</span>${task.dueDate ? `<span class="${task.dueDate < rules.today() && !['done', 'cancelled'].includes(task.status) ? 'task-overdue' : ''}">截止 ${task.dueDate}</span>` : ''}${task.plannedDate ? `<span>计划 ${task.plannedDate} ${esc(task.plannedStartTime)}${task.plannedEndTime ? `—${esc(task.plannedEndTime)}` : ''}</span>` : ''}${task.estimatedMinutes ? `<span>预计 ${task.estimatedMinutes} 分钟</span>` : ''}</div></div><label class="field task-status-label">状态<select data-task-status="${esc(task.id)}">${Object.entries(statusText).map(([key, label]) => `<option value="${key}" ${task.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label></article>`;
  function ruleText(event) {
    if (!event.recurrence) return `${event.date} ${event.time || '时间未注明'}${event.endDate ? ` 至 ${event.endDate}` : ''}${event.endTime ? ` — ${event.endTime}` : ''}`;
    const rule = event.recurrence;
    return `${event.date} 至 ${rule.until} · 每${rule.intervalWeeks > 1 ? ` ${rule.intervalWeeks} ` : ''}周${rule.weekdays.map(day => weekdays[day - 1]).join('、')} ${event.time || '时间未注明'}${event.endTime ? `—${event.endTime}` : ''}${rule.weeks.length ? ` · 第 ${rule.weeks.join('、')} 周` : ''}${rule.excludeDates.length ? ` · ${rule.excludeDates.length} 次例外` : ''}`;
  }
  function drawTasks() {
    drawnView = 'tasks';
    const visible = tasks.filter(task => taskStatus === 'all' || task.status === taskStatus);
    host().innerHTML = heading('个人任务', '记录你明确要做的事，保存执行时段和完成进度。', '<button class="button primary" data-planner="add-task">＋ 添加任务</button>') + `<div class="planner-toolbar">${select('task-filter', '任务状态', taskStatus, { all: '全部任务', ...statusText })}<span>${tasks.filter(task => task.status === 'todo').length} 项待办 · ${tasks.filter(task => task.status === 'in_progress').length} 项进行中 · ${tasks.filter(task => task.status === 'done').length} 项已完成</span></div><div class="task-list">${visible.map(taskCard).join('') || empty('还没有这类任务。可以手动添加，或让 Agent 根据你的目标创建。')}</div>`;
  }
  function drawEvents() {
    drawnView = 'events';
    const visible = events.filter(event => (event.recurrence ? 'recurring' : 'once') === eventType && (showInactive || event.active));
    host().innerHTML = heading('日程与课程', '日程和课程均可选择一次性或周期性。课表截图可交给 Agent 识别，结合学期和节次设置导入。', '<button class="button primary" data-planner="add-event">＋ 添加事件</button>') + `<div class="planner-toolbar"><div class="planner-tabs"><button data-event-type="once" class="${eventType === 'once' ? 'active' : ''}">一次性事件</button><button data-event-type="recurring" class="${eventType === 'recurring' ? 'active' : ''}">周期性事件</button></div><label class="inline-check"><input type="checkbox" id="show-inactive" ${showInactive ? 'checked' : ''}> 显示已取消</label></div><div class="event-rule-list">${visible.map(event => `<article class="event-rule-card ${event.active ? '' : 'inactive-event'}"><div><span class="event-type-tag ${event.recurrence ? 'recurring-tag' : ''}">${event.recordType === 'course' ? '课程' : '日程'} · ${event.recurrence ? '周期' : '一次性'}${event.active ? '' : ' · 已取消'}</span><h3>${esc(event.title)}</h3><p>${esc(ruleText(event))}</p>${event.location ? `<p>地点：${esc(event.location)}</p>` : ''}${event.sourceName ? `<small>来源：${esc(event.sourceName)}</small>` : ''}</div><div class="planner-card-actions"><button class="button secondary" data-planner="edit-event" data-id="${esc(event.id)}">${event.recurrence ? '编辑整个系列' : '编辑'}</button>${event.recurrence && event.active ? `<button class="text-button" data-planner="occurrence" data-id="${esc(event.id)}">调整某一次</button>` : ''}<button class="text-button" data-planner="toggle-event" data-id="${esc(event.id)}">${event.active ? '取消' : '恢复'}</button></div></article>`).join('') || empty(`暂无${eventType === 'recurring' ? '周期性' : '一次性'}日程或课程。原文中的安排仍在“事件时间表”展示。`)}</div>`;
  }
  function drawPreferences() {
    const p = preferences;
    host().innerHTML = heading('时间偏好与课表设置', '这些设置会保存到当前账号，供 Agent 跨会话读取。学期第 1 周与节次作息用于准确导入课表。') + `<form id="preferences-form" class="planner-form"><div class="field-row">${field('dailyCapacityMinutes', '每天可安排的任务时长（分钟）', p.dailyCapacityMinutes, 'number', 'required min="0" max="1440"')}${field('bufferMinutes', '事项间缓冲（分钟）', p.bufferMinutes, 'number', 'required min="0" max="180"')}</div><div class="field-row">${field('dayStart', '可安排时段开始', p.dayStart, 'time', 'required')}${field('dayEnd', '可安排时段结束', p.dayEnd, 'time', 'required')}</div><div class="field-row">${field('semesterStart', '学期第 1 周日期（可选）', p.semesterStart, 'date')}${field('semesterEnd', '学期结束日期（可选）', p.semesterEnd, 'date')}</div><p class="planner-note">学期周次以第 1 周日期所在周的周一为起点；未填写时 Agent 会在需要时向你核对。</p><fieldset class="event-editor"><legend>节次作息</legend><div id="period-fields">${p.classPeriods.map(periodRow).join('')}</div><button type="button" class="button secondary" data-planner="add-period">＋ 添加节次</button></fieldset>${area('notes', '其他时间约束或偏好', p.notes, 2000)}<div class="planner-save-row"><span>${p.version === 0 ? '尚未保存；当前数值为初始建议，可按实际情况修改。' : '设置已保存在当前账号。'}</span><button type="submit" class="button primary">保存偏好</button></div></form>`;
  }
  function periodRow(period = {}) { return `<div class="period-row">${field('period', '节次', period.period || '', 'number', 'required min="1" max="30"')}${field('start', '开始', period.start || '', 'time', 'required')}${field('end', '结束', period.end || '', 'time', 'required')}<button type="button" class="text-button" data-planner="remove-period">移除</button></div>`; }
  function drawReviewForm() {
    reviewSignature = '';
    const today = rules.today(), monday = rules.shiftDay(today, -((new Date(today).getUTCDay() + 6) % 7));
    host().innerHTML = heading('计划复盘', '查看真实的任务状态、完成记录和计划调整。预计时长仅是估计，不等同实际学习时长。') + `<form id="review-form" class="planner-toolbar">${field('from', '开始日期', monday, 'date', 'required')}${field('to', '结束日期', today, 'date', 'required')}<button class="button secondary" type="submit">查看复盘</button></form><div id="review-result"></div>`;
    loadReview(monday, today);
  }
  async function loadReview(from, to) {
    const generation = ++reviewGeneration;
    try {
      const result = await request(`/api/review?${new URLSearchParams({ from, to })}`);
      if (view !== 'review' || generation !== reviewGeneration) return;
      const signature = JSON.stringify(result);
      if (reviewSignature === signature) return;
      reviewSignature = signature;
      $('review-result').innerHTML = `<div class="review-stats"><div><strong>${result.completed.length}</strong>期间完成</div><div><strong>${result.scheduled.length}</strong>期间有计划</div><div><strong>${result.due.length}</strong>期间到期</div><div><strong>${result.overdue.length}</strong>当前逾期</div></div>${[['期间完成', result.completed], ['当前逾期未完成', result.overdue]].map(([title, items]) => `<h3 class="review-group-title">${title}</h3>${items.length ? items.map(taskCard).join('') : empty('暂无记录。')}`).join('')}<details class="review-history"><summary>期间的任务变更（${result.changes.length}${result.changesTruncated ? '，仅显示部分' : ''} 条）</summary>${result.changes.map(change => `<p>${esc(new Date(change.changedAt || change.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }))} · ${esc(change.after?.title || change.title || '任务变更')} ${esc(change.after?.status ? statusText[change.after.status] : '')}</p>`).join('')}</details>`;
    } catch (error) { message(error.message); }
  }
  async function refresh() {
    if (!view || busyView === view) return;
    const current = view, generation = ++refreshGeneration;
    busyView = current;
    try {
      if (current === 'tasks') { const result = await request('/api/tasks'); if (view === current && generation === refreshGeneration) { const changed = JSON.stringify(tasks) !== JSON.stringify(result.tasks); tasks = result.tasks; if (changed || drawnView !== current) drawTasks(); } }
      if (current === 'events') { const result = await request('/api/event-rules'); if (view === current && generation === refreshGeneration) { const changed = JSON.stringify(events) !== JSON.stringify(result.events); events = result.events; if (changed || drawnView !== current) drawEvents(); } }
      if (current === 'review' && $('review-form')) { const values = Object.fromEntries(new FormData($('review-form'))); await loadReview(values.from, values.to); }
    } catch (error) { message(error.message); }
    finally { if (generation === refreshGeneration) busyView = ''; }
  }
  async function open(next) {
    if (view === next) return;
    view = next; drawnView = ''; const generation = ++viewGeneration;
    host().innerHTML = '<p class="planner-intro">正在读取…</p>';
    try {
      if (next === 'preferences') { const result = await request('/api/preferences'); if (view === next && generation === viewGeneration) { preferences = result; drawPreferences(); } }
      else if (next === 'review') drawReviewForm();
      else await refresh();
    } catch (error) { if (view === next && generation === viewGeneration) host().innerHTML = empty(error.message); }
  }
  function dialog(title, content, mode, data) {
    editing = { mode, data };
    $('planner-dialog').innerHTML = `<form id="planner-edit-form"><div class="dialog-heading"><h2 id="planner-dialog-title">${title}</h2><button type="button" class="icon-button" data-planner="close-dialog" aria-label="关闭编辑窗口">×</button></div><div class="form-fields">${content}<p id="planner-form-error" class="planner-form-error" role="alert" hidden></p></div><div class="dialog-footer"><span>未注明的信息留空，保存后可继续调整。</span><div><button type="button" class="button secondary" data-planner="close-dialog">取消</button><button type="submit" class="button primary">保存</button></div></div></form>`;
    if (!$('planner-dialog').open) $('planner-dialog').showModal();
  }
  function newTask(task = {}) {
    dialog(task.id ? '编辑任务与计划' : '添加个人任务', `${field('title', '任务名称', task.title, 'text', 'required maxlength="120"')}<div class="field-row">${select('status', '状态', task.status || 'todo', statusText)}${select('priority', '优先级', task.priority || 'normal', priorityText)}</div><div class="field-row">${field('dueDate', '截止日期（可选）', task.dueDate, 'date')}${field('estimatedMinutes', '预计用时（分钟）', task.estimatedMinutes || 0, 'number', 'min="0" max="10080" required')}</div>${field('plannedDate', '计划执行日期（可选）', task.plannedDate, 'date')}<div class="field-row">${field('plannedStartTime', '计划开始时间（可选）', task.plannedStartTime, 'time')}${field('plannedEndTime', '计划结束时间（可选）', task.plannedEndTime, 'time')}</div>${area('notes', '说明与完成判断', task.notes)}`, 'task', task);
  }
  async function openTask(id) { tasks = (await request('/api/tasks')).tasks; const task = tasks.find(task => task.id === id); if (!task) throw new Error('任务不存在，请刷新。'); newTask(task); }
  function setCategories(names) { categoryNames = [...new Set(names)]; }
  function setDefaultCategories(schedule, course) { defaultCategories = { schedule, course }; }
  function setEventEditor(handler) { eventEditor = handler; }
  function newEvent(category, recurring, recordType = 'schedule') {
    category ||= defaultCategories[recordType];
    return eventEditor({ category: categoryNames.includes(category) ? category : categoryNames.includes('其他通知') ? '其他通知' : categoryNames[0], recurring: recurring ?? recordType === 'course', recordType });
  }
  function openEvent(id) { return eventEditor({ id, source: 'event' }); }
  async function openOccurrence(id, date) {
    events = (await request('/api/event-rules')).events;
    const event = events.find(event => event.id === id);
    if (!event?.recurrence) throw new Error('周期事件不存在，请刷新。');
    dialog('仅调整这一次课程／事件', `${field('occurrenceDate', '原发生日期', date || '', 'date', 'required')}${select('operation', '本次操作', 'move', { move: '调整这一次', cancel: '仅这一次停课／取消' })}<div id="occurrence-changes">${field('date', '调整后的日期', date || '', 'date')}<div class="field-row">${field('time', '调整后的开始时间', event.time, 'time')}${field('endTime', '调整后的结束时间', event.endTime, 'time')}</div>${field('location', '本次地点', event.location, 'text', 'maxlength="120"')}</div><p class="planner-note">仅排除原日期这一课次，调课会另建一次性事件；后续周的课程保持原规则。</p>`, 'occurrence', event);
  }
  async function saveDialog(form) {
    const values = Object.fromEntries(new FormData(form)), { mode, data } = editing;
    if (mode === 'task') {
      values.estimatedMinutes = Number(values.estimatedMinutes); values.noticeId = data.noticeId || '';
      const result = await request('/api/tasks', data.id ? 'PATCH' : 'POST', data.id ? { id: data.id, expectedVersion: data.version, patch: values } : { task: values });
      message(result.duplicate ? '任务已存在，已保留原有任务。' : '任务与计划已保存。');
    } else {
      await request('/api/event-occurrence', 'PATCH', { id: data.id, expectedVersion: data.version, occurrenceDate: values.occurrenceDate, changes: values.operation === 'cancel' ? null : { date: values.date, time: values.time, endTime: values.endTime, location: values.location } });
      message('仅本次安排已调整，后续周期保持不变。');
    }
    $('planner-dialog').close(); await refresh(); document.dispatchEvent(new Event('planner:changed'));
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('[data-planner], [data-event-type]');
    if (!button) return;
    if (button.dataset.eventType) { eventType = button.dataset.eventType; drawEvents(); return; }
    try {
      const action = button.dataset.planner;
      if (action === 'add-task') newTask();
      if (action === 'edit-task') await openTask(button.dataset.id);
      if (action === 'add-event') await newEvent();
      if (action === 'edit-event') await openEvent(button.dataset.id);
      if (action === 'occurrence') await openOccurrence(button.dataset.id);
      if (action === 'close-dialog') $('planner-dialog').close();
      if (action === 'add-period') { if ($('period-fields').children.length >= 30) throw new Error('最多添加 30 个节次。'); $('period-fields').insertAdjacentHTML('beforeend', periodRow()); }
      if (action === 'remove-period') button.closest('.period-row').remove();
      if (action === 'toggle-event') { const item = events.find(item => item.id === button.dataset.id); await request('/api/events', 'PATCH', { id: item.id, expectedVersion: item.version, patch: { active: !item.active } }); await refresh(); document.dispatchEvent(new Event('planner:changed')); }
    } catch (error) { message(error.message); }
  });
  document.addEventListener('change', async event => {
    try {
      if (event.target.name === 'task-filter') { taskStatus = event.target.value; drawTasks(); }
      if (event.target.id === 'show-inactive') { showInactive = event.target.checked; drawEvents(); }
      if (event.target.name === 'operation') $('occurrence-changes').hidden = event.target.value === 'cancel';
      if (event.target.dataset.taskStatus) { const task = (await request('/api/tasks')).tasks.find(task => task.id === event.target.dataset.taskStatus); if (!task) throw new Error('任务不存在，请刷新。'); await request('/api/tasks', 'PATCH', { id: task.id, expectedVersion: task.version, patch: { status: event.target.value } }); await refresh(); document.dispatchEvent(new Event('planner:changed')); }
    } catch (error) { message(error.message); await refresh(); }
  });
  document.addEventListener('submit', async event => {
    if (!['planner-edit-form', 'preferences-form', 'review-form'].includes(event.target.id)) return;
    event.preventDefault(); const button = event.submitter; if (button) button.disabled = true;
    try {
      if (event.target.id === 'planner-edit-form') await saveDialog(event.target);
      if (event.target.id === 'review-form') { const values = Object.fromEntries(new FormData(event.target)); await loadReview(values.from, values.to); }
      if (event.target.id === 'preferences-form') {
        const values = Object.fromEntries(new FormData(event.target));
        for (const key of ['dailyCapacityMinutes', 'bufferMinutes']) values[key] = Number(values[key]);
        for (const key of ['period', 'start', 'end']) delete values[key];
        values.classPeriods = [...$('period-fields').children].map(row => ({ period: Number(row.querySelector('[name="period"]').value), start: row.querySelector('[name="start"]').value, end: row.querySelector('[name="end"]').value }));
        const generation = viewGeneration; preferences = await request('/api/preferences', 'PATCH', { patch: values, expectedVersion: preferences.version }); if (view === 'preferences' && generation === viewGeneration) drawPreferences(); message('时间偏好与课表设置已保存。');
      }
    } catch (error) { if (event.target.id === 'planner-edit-form') { $('planner-form-error').textContent = error.message; $('planner-form-error').hidden = false; } else message(error.message); }
    finally { if (button) button.disabled = false; }
  });
  return { open, refresh, newTask, openTask, newEvent, openEvent, openOccurrence, setCategories, setDefaultCategories, setEventEditor, deactivate: () => { if (view) { view = ''; viewGeneration++; reviewGeneration++; } } };
})();
