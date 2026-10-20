'use strict';

const STORAGE_KEY = 'campus-notice-inbox.v1';
const DEFAULT_CATEGORIES = [
  { name: '课程学习', color: '#8187cc', background: '#eef0fc' },
  { name: '校园活动', color: '#6da990', background: '#ebf5ee' },
  { name: '竞赛报名', color: '#bf9068', background: '#faf0e7' },
  { name: '校园事务', color: '#9c85be', background: '#f2ecf9' },
  { name: '日程', color: '#528fab', background: '#eef6fa' },
  { name: '课程', color: '#9174b8', background: '#f3eef9' },
  { name: '其他通知', color: '#8e99aa', background: '#eef1f5' }
];
let CATEGORIES = DEFAULT_CATEGORIES;
const categoryLabel = name => name === '其他通知' ? (CATEGORIES.some(category => category.name === '其他事件') ? '其他事件（默认）' : '其他事件') : name;
function categoryStyle(name) {
  const known = CATEGORIES.find(category => category.name === name) || DEFAULT_CATEGORIES.find(category => category.name === name);
  if (known?.border) return known;
  if (known) {
    const channels = known.color.slice(1).match(/../g).map(value => parseInt(value, 16));
    const border = '#' + channels.map(value => Math.round(value * .45 + 255 * .55).toString(16).padStart(2, '0')).join('');
    return { ...known, border };
  }
  let hash = 2166136261;
  for (const character of name) hash = Math.imul(hash ^ character.codePointAt(0), 16777619) >>> 0;
  const hue = hash % 360, saturation = 35 + (hash >>> 9) % 15;
  return { name, color: `hsl(${hue},${saturation}%,43%)`, border: `hsl(${hue},${saturation}%,79%)`, background: `hsl(${hue},45%,97%)` };
}
const VIEW_NAMES = { all: '全部事件', soon: '即将截止', favorites: '我的收藏' };
const state = { view: 'all', category: '', query: '', sort: 'newest', type: 'all', repeat: 'all', showCancelled: false, selected: null, editing: null };
const Schedule = globalThis.ZhihuiSchedule;
const scheduleState = { from: Schedule.today(), to: Schedule.shiftDay(Schedule.today(), 6), kind: 'all', type: 'all', preset: 7 };
const $ = (id) => document.getElementById(id);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const offsetDay = (offset) => { const day = new Date(); day.setDate(day.getDate() + offset); return localDay(day); };
const formatDay = (value) => value ? `${Number(value.slice(5, 7))} 月 ${Number(value.slice(8, 10))} 日` : '未注明';
const dayDifference = (value) => {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  const today = new Date();
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
};
const isSoon = (notice) => { const days = dayDifference(notice.deadline); return days !== null && days >= 0 && days < 7; };
const safeURL = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const validDay = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && localDay(new Date(`${value}T12:00:00`)) === value;
let scheduleResult = null, scheduleSignature = '', scheduleGeneration = 0, scheduleInFlight = '';
let toastTimer;
let undoAction = null;

function normalizeNotice(raw) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim()) throw new Error('事件需要标题。');
  const text = (key, max = 20000) => typeof raw[key] === 'string' ? raw[key].trim().slice(0, max) : '';
  const deadline = text('deadline', 10), publishedAt = text('publishedAt', 10);
  if (!validDay(deadline) || !validDay(publishedAt)) throw new Error('事件日期格式需要为 YYYY-MM-DD，并且是有效日期。');
  const sourceUrl = text('sourceUrl', 2000);
  if (sourceUrl && !safeURL(sourceUrl)) throw new Error('原文链接需要使用 http:// 或 https://。');
  return { updatedAt: raw.updatedAt, recordType: raw.recordType === 'course' ? 'course' : 'schedule', participation: raw.participation === 'planned' ? 'planned' : 'reference', active: raw.active !== false, id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 160) : crypto.randomUUID(), title: text('title', 120), content: text('content'), summary: text('summary', 240), category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : '其他通知', sourceName: text('sourceName', 80), sourceUrl, deadline, publishedAt, events: Schedule.normalizeEvents(raw.events), audience: text('audience', 120), location: text('location', 120), createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(), favorite: raw.favorite === true, isDemo: raw.isDemo === true, importedBy: text('importedBy', 20) };
}

function loadNotices() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) return [];
    const values = JSON.parse(saved);
    if (!Array.isArray(values)) throw new Error();
    return values.map(normalizeNotice);
  } catch { setTimeout(() => toast('无法读取浏览器中的记录，可以导入备份恢复。'), 0); return []; }
}
const legacyNotices = loadNotices().filter(n => !n.isDemo);
let notices = [], eventRules = [], scheduleCategory = '日程', courseCategory = '课程', serverReady = false, fetching = false, writing = false;
let noticeGeneration = 0, refreshQueued = false;

async function api(method = 'GET', body, path = '/api/notices') {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (response.redirected || response.status === 401) { if (document.body.dataset.auth === 'email') location.assign('/login'); throw new Error('登录已失效，请重新打开网页登录。'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '事件服务暂时不可用。');
  return data;
}

async function refreshNotices(announce = false, notifyNew = true) {
  if (fetching || writing) { refreshQueued = true; return; }
  fetching = true;
  const generation = noticeGeneration;
  try {
    const result = await api();
    if (generation !== noticeGeneration) { refreshQueued = true; return; }
    if (typeof result.scheduleCategory === 'string') scheduleCategory = result.scheduleCategory;
    if (typeof result.courseCategory === 'string') courseCategory = result.courseCategory;
    globalThis.ZhihuiPlanner.setDefaultCategories(scheduleCategory, courseCategory);
    $('manage-categories').hidden = !Array.isArray(result.categories);
    const categoriesChanged = Array.isArray(result.categories) && JSON.stringify(result.categories) !== JSON.stringify(CATEGORIES.map(c => c.name));
    if (categoriesChanged) setCategories(result.categories);
    const incoming = result.notices.map(normalizeNotice);
    const incomingRules = Array.isArray(result.eventRules) ? result.eventRules : [];
    const known = new Set(listEntries(true).map(n => n.key));
    const added = incoming.filter(n => !known.has(`notice:${n.id}`)).length + incomingRules.filter(n => !known.has(`event:${n.id}`)).length;
    const wasReady = serverReady;
    serverReady = true;
    if (JSON.stringify(incoming) !== JSON.stringify(notices) || JSON.stringify(incomingRules) !== JSON.stringify(eventRules) || categoriesChanged) { notices = incoming; eventRules = incomingRules; render(); }
    const signature = n => JSON.stringify([n.title, n.content, n.sourceUrl].map(s => s.replace(/\s+/g, ' ').trim()));
    const existing = new Set(incoming.flatMap(n => [n.id, signature(n)]));
    const remaining = legacyNotices.filter(n => !existing.has(n.id) && !existing.has(signature(n)));
    $('migration-banner').hidden = !remaining.length;
    $('migration-message').textContent = `本浏览器有 ${remaining.length} 条旧版事件尚未迁移，可以保存到当前登录的账号。原有本地数据会保留。`;
    $('sync-status').textContent = '已连接事件库 · 每 5 秒自动刷新';
    $('sync-status').classList.remove('sync-error');
    if (announce) toast('已刷新事件库');
    else if (notifyNew && wasReady && added) toast(`收到 ${added} 条新事件`);
  } catch (error) {
    if (generation !== noticeGeneration) { refreshQueued = true; return; }
    serverReady = false;
    $('sync-status').textContent = '连接失败，点击“立即刷新”重试';
    $('sync-status').classList.add('sync-error');
    if (announce) toast(error.message);
  } finally { fetching = false; if (refreshQueued && !writing) { refreshQueued = false; void refreshNotices(false, false); } }
}

async function writeNotices(button, action) {
  if (!serverReady) { toast('事件库尚未连接，请先刷新或重新登录。'); return; }
  if (writing) { toast('正在保存，请稍后。'); return; }
  writing = true;
  noticeGeneration++;
  if (button) button.disabled = true;
  let succeeded = false;
  try { await action(); succeeded = true; }
  catch (error) { toast(error.message || '保存失败，请稍后重试。'); }
  finally { writing = false; if (button) button.disabled = false; }
  if (succeeded || refreshQueued) await refreshNotices(false, false);
}

async function importBatches(incoming) {
  let imported = 0, skipped = 0;
  for (let i = 0; i < incoming.length; i += 50) {
    try {
      const result = await api('POST', { notices: incoming.slice(i, i + 50) });
      imported += result.imported; skipped += result.skipped;
    } catch (error) { throw new Error(`已保存 ${imported} 条、跳过 ${skipped} 条。${error.message} 可重试，已有事件不会重复导入。`); }
  }
  return { imported, skipped };
}

function toast(message, undo = null) {
  clearTimeout(toastTimer);
  $('toast-message').textContent = message;
  undoAction = undo;
  $('undo-button').hidden = !undo;
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; undoAction = null; }, undo ? 10000 : 4500);
}

function deadlineLabel(notice) {
  const days = dayDifference(notice.deadline);
  if (days === null) return { label: '未标明截止日期', style: '' };
  if (days < 0) return { label: `${formatDay(notice.deadline)} · 已截止`, style: 'overdue' };
  if (days === 0) return { label: '今天截止', style: 'urgent' };
  if (days === 1) return { label: '明天截止', style: 'urgent' };
  return { label: days < 7 ? `还剩 ${days} 天 · ${formatDay(notice.deadline)}截止` : `${formatDay(notice.deadline)} 截止`, style: days < 7 ? 'urgent' : '' };
}

function listEntries(includeCancelled = state.showCancelled) {
  const entries = [
    ...notices.map(n => ({ ...n, key: `notice:${n.id}`, entrySource: 'notice', repeatType: n.events.some(event => event.recurrence) ? 'recurring' : 'once' })),
    ...eventRules.map(event => ({ ...event, key: `event:${event.id}`, entrySource: 'event', participation: event.participation || 'planned', repeatType: event.recurrence ? 'recurring' : 'once' }))
  ];
  return entries.filter(entry => includeCancelled || entry.active !== false).map(entry => ({ ...entry, entryType: entry.recordType === 'course' ? 'course' : 'event' }));
}
const noticeTimeCache = new Map();
function noticeTiming(entry) {
  const from = Schedule.today(), stamp = JSON.stringify([entry.events, entry.deadline, entry.active, from, Math.floor(Date.now() / 60000)]);
  const cached = noticeTimeCache.get(entry.id);
  if (cached?.stamp === stamp) return cached;
  const events = [...entry.events], candidates = [];
  if (entry.deadline && !events.some(event => event.kind === 'deadline' && event.date === entry.deadline)) events.push({ title: entry.title, date: entry.deadline, kind: 'deadline' });
  for (const event of events) {
    if (!event.date) continue;
    const until = event.recurrence?.until || event.endDate || event.date;
    for (let start = event.date > from ? event.date : from; start <= until;) {
      const end = Schedule.shiftDay(start, 365) < until ? Schedule.shiftDay(start, 365) : until;
      const next = globalThis.ZhihuiEventRules.expandEvent({ ...event, active: entry.active }, start, end).find(value => {
        const time = value.endTime || (value.kind === 'deadline' ? value.time : '') || '23:59:59.999';
        return Date.parse(`${value.endDate || value.date}T${time.length === 5 ? time + ':00' : time}+08:00`) > Date.now();
      });
      if (next) { candidates.push(next); break; }
      start = Schedule.shiftDay(end, 1);
    }
  }
  candidates.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  const next = candidates[0] || null, deadline = candidates.find(event => event.kind === 'deadline') || null;
  const result = { stamp, next, deadline }; noticeTimeCache.set(entry.id, result); return result;
}
const entryDeadline = entry => entry.entrySource === 'notice' ? noticeTiming(entry).deadline?.date || entry.deadline || entry.events.filter(event => event.kind === 'deadline').map(event => event.date).filter(Boolean).sort().at(-1) || '' : entry.kind === 'deadline' ? entry.nextOccurrence?.date || '' : '';
const entrySoon = entry => isSoon({ deadline: entryDeadline(entry) });
const entryDate = entry => entry.entrySource === 'event' ? entry.nextOccurrence?.date || '' : noticeTiming(entry).next?.date || '';
const entryTypeLabel = entry => `${entry.entryType === 'course' ? '课程' : '事件'}${entry.repeatType === 'recurring' ? ' · 每周重复' : ''}`;
const participationLabel = entry => entry.participation === 'planned' ? '已纳入安排' : '资料信息';
function ruleLabel(event) {
  if (!event.recurrence) return eventDateLabel(event);
  const rule = event.recurrence, weekdays = ['一', '二', '三', '四', '五', '六', '日'];
  const frequency = rule.intervalWeeks > 1 ? `每 ${rule.intervalWeeks} 周 · ` : '每周';
  const weeks = rule.weeks || [], consecutive = weeks.every((week, index) => !index || week === weeks[index - 1] + 1);
  const scope = weeks.length ? ` · 第 ${consecutive && weeks.length > 1 ? `${weeks[0]}—${weeks.at(-1)}` : weeks.join('、')} 周` : '';
  return `${frequency}${rule.weekdays.map((day, index) => `${index || rule.intervalWeeks > 1 ? '周' : ''}${weekdays[day - 1]}`).join('、')} · ${event.time || '时分未注明'}${event.endTime ? `—${event.endTime}` : ''}${scope}`;
}
function nextLabel(event) {
  if (event.active === false) return '已取消';
  if (event.scheduleStatus === 'undated' || !event.date && !event.recurrence) return '时间待定 · 可在编辑中补充';
  const next = event.nextOccurrence;
  if (!next) return '已结束 · 暂无后续安排';
  return `${event.scheduleStatus === 'ongoing' ? '进行中' : event.recurrence ? '下次' : '安排'}：${next.date}${next.time ? ` ${next.time}` : ' · 时分未注明'}${next.endTime ? `—${next.endTime}` : ''}`;
}
function filteredNotices() {
  const query = state.query.toLowerCase();
  return listEntries().filter(n => (!state.category || n.category === state.category) && (state.type === 'all' || n.entryType === state.type) && (state.repeat === 'all' || n.repeatType === state.repeat) && (state.view !== 'soon' || entrySoon(n)) && (state.view !== 'favorites' || n.favorite) && (!query || [n.title, n.content, n.summary, n.notes, n.sourceText, n.sourceName, n.audience, n.location, n.nextOccurrence?.location].some(value => value?.toLowerCase().includes(query)))).sort((a, b) => {
    if (state.sort === 'deadline') return (entryDeadline(a) || '9999').localeCompare(entryDeadline(b) || '9999') || b.createdAt - a.createdAt;
    if (state.sort === 'next') return (entryDate(a) || '9999').localeCompare(entryDate(b) || '9999') || (a.nextOccurrence?.time || '99:99').localeCompare(b.nextOccurrence?.time || '99:99') || b.createdAt - a.createdAt;
    return state.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt;
  });
}
function renderCard(n) {
  const category = categoryStyle(n.category), personal = n.entrySource === 'event', deadline = deadlineLabel({ deadline: entryDeadline(n) });
  const summary = personal ? n.notes || ruleLabel(n) : n.summary || n.content || (n.events[0] ? ruleLabel(n.events[0]) : '时间和详细信息可稍后补充');
  const source = personal ? n.nextOccurrence?.location || n.location || n.sourceName || '地点未注明' : n.sourceName || '来源未注明';
  return `<article style="--category-color:${category.color};--category-background:${category.background};--category-border:${category.border}" class="notice-card category-colored-card ${personal ? 'personal-event-card' : ''} ${n.key === state.selected ? 'selected' : ''} ${n.active === false ? 'inactive-event' : ''}"><button class="notice-open" data-action="${personal ? 'select-rule' : 'select'}" data-id="${escapeHTML(n.id)}" aria-pressed="${n.key === state.selected}" aria-label="查看${entryTypeLabel(n)}：${escapeHTML(n.title)}"><div class="card-top"><span class="category-badge" style="color:${category.color};background:${category.background}">${escapeHTML(categoryLabel(n.category))}</span><span class="inbox-type-tag ${n.entryType}">${entryTypeLabel(n)}</span><span class="participation-tag">${participationLabel(n)}</span>${n.isDemo ? '<span class="sample-badge">示例</span>' : ''}</div><h3>${personal ? icon(n.recordType === 'course' ? 'book' : 'clock') : ''}${escapeHTML(n.title)}</h3><p class="card-summary">${escapeHTML(summary)}</p>${personal ? `<p class="inbox-next ${n.active === false || !n.nextOccurrence ? 'ended' : ''}">${escapeHTML(nextLabel(n))}</p>` : n.active === false ? '<p class="inbox-next ended">已取消</p>' : noticeTiming(n).next ? `<p class="inbox-next">${escapeHTML(eventDateLabel(noticeTiming(n).next))}</p>` : '<p class="inbox-next ended">暂无后续时间安排</p>'}<div class="card-footer"><span class="card-source">${icon(personal ? n.recordType === 'course' ? 'book' : 'clock' : 'file')}<span>${escapeHTML(source)}</span>${n.importedBy === 'agent' ? '<span class="agent-badge">Agent 导入</span>' : ''}</span>${!personal && entryDeadline(n) ? `<span class="deadline-badge ${deadline.style}">${icon('clock')}${deadline.label}</span>` : ''}</div></button><button class="favorite-button ${n.favorite ? 'is-favorite' : ''}" data-action="${personal ? 'favorite-rule' : 'favorite'}" data-id="${escapeHTML(n.id)}" title="${n.favorite ? '取消收藏' : '收藏事件'}" aria-label="${n.favorite ? '取消收藏' : '收藏事件'}：${escapeHTML(n.title)}" aria-pressed="${n.favorite}">${icon('star')}</button></article>`;
}
function render() {
  const entries = listEntries();
  const counts = { all: entries.length, soon: entries.filter(entrySoon).length, favorites: entries.filter(n => n.favorite).length };
  Object.entries(counts).forEach(([key, count]) => { $(`stat-${key}`).textContent = count; $(`nav-${key}`).textContent = count; });
  document.querySelectorAll('#view-nav [data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === state.view); button.setAttribute('aria-pressed', String(button.dataset.view === state.view)); });
  $('category-nav').innerHTML = CATEGORIES.map(c => `<button class="nav-item ${state.category === c.name ? 'active' : ''}" data-category="${escapeHTML(c.name)}" aria-pressed="${state.category === c.name}"><span class="category-dot" style="background:${c.color}"></span><span class="category-name">${escapeHTML(categoryLabel(c.name))}</span><span class="nav-count">${entries.filter(n => n.category === c.name).length}</span></button>`).join('');
  $('demo-banner').hidden = !notices.some(n => n.isDemo);
  const plannerView = ['tasks', 'events', 'preferences', 'review'].includes(state.view);
  $('planner-section').hidden = !plannerView;
  $('schedule-section').hidden = state.view !== 'schedule';
  $('notices-section').hidden = state.view === 'schedule' || plannerView;
  if (plannerView) { globalThis.ZhihuiPlanner.open(state.view); return; }
  globalThis.ZhihuiPlanner.deactivate();
  if (state.view === 'schedule') { renderSchedule(); return; }
  const visible = filteredNotices();
  if (!visible.some(n => n.key === state.selected)) state.selected = visible[0]?.key ?? null;
  $('list-heading').textContent = state.view === 'all' && state.category ? categoryLabel(state.category) : VIEW_NAMES[state.view];
  $('result-count').textContent = `${visible.length} 条事件`;
  $('active-filter').hidden = !state.category;
  $('active-filter').innerHTML = state.category ? `${escapeHTML(categoryLabel(state.category))}<button data-action="clear-category">清除筛选 ×</button>` : '';
  $('notice-list').innerHTML = visible.map(renderCard).join('');
  $('empty-state').hidden = visible.length > 0;
  const filtering = !!state.query || !!state.category || state.view !== 'all' || state.type !== 'all' || state.repeat !== 'all';
  $('empty-title').textContent = filtering ? '没有符合条件的事件' : '还没有事件';
  $('empty-description').textContent = filtering ? '换个关键词，或清除筛选再看看。' : '添加一条事件，可以先保存标题，再补充时间和资料。';
  $('empty-action').textContent = filtering ? '清除筛选' : '添加事件';
  renderDetail();
}

function eventDateLabel(event) {
  if (!event.date) return '时间待定';
  const start = `${event.date}${event.time ? ` ${event.time}` : ' · 时间未注明'}`;
  return event.endDate || event.endTime ? `${start} — ${event.endDate || event.date}${event.endTime ? ` ${event.endTime}` : ' · 结束时分未注明'}` : start;
}

function renderSchedule() {
  if (scheduleState.preset) { scheduleState.from = Schedule.today(); scheduleState.to = Schedule.shiftDay(scheduleState.from, scheduleState.preset - 1); }
  const { from, to, kind, type } = scheduleState;
  $('schedule-from').value = from; $('schedule-to').value = to;
  $('schedule-kind').value = kind;
  document.querySelectorAll('.range-preset').forEach(button => { const active = Number(button.dataset.days) === scheduleState.preset; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); });
  $('schedule-type').value = type;
  const signature = JSON.stringify([from, to, kind, type]);
  if (document.body.dataset.auth === 'email' && signature !== scheduleSignature) { scheduleSignature = signature; scheduleResult = null; loadSchedule(); }
  if (document.body.dataset.auth === 'email' && !scheduleResult) { $('schedule-summary').textContent = '正在读取时间表…'; $('schedule-list').innerHTML = ''; return; }
  const entries = document.body.dataset.auth === 'email' ? scheduleResult.events : Schedule.collect(notices, from, to, kind);
  const groups = new Map();
  for (const event of entries) {
    if (!groups.has(event.displayDate)) groups.set(event.displayDate, []);
    groups.get(event.displayDate).push(event);
  }
  const activities = entries.filter(event => event.kind === 'event').length;
  $('schedule-summary').innerHTML = `<span class="schedule-period">${escapeHTML(from)} <span>—</span> ${escapeHTML(to)}</span><div><strong>${entries.length}</strong> 个事项<span class="schedule-summary-divider">/</span><span class="schedule-key activity-key"></span>${activities} 个活动<span class="schedule-key deadline-key"></span>${entries.length - activities} 个截止事项</div>`;
  $('schedule-list').innerHTML = entries.length ? [...groups].map(([date, events]) => {
    const relative = date === Schedule.today() ? '今天' : date === Schedule.shiftDay(Schedule.today(), 1) ? '明天' : '';
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' }).format(new Date(`${date}T12:00:00+08:00`));
    return `<section class="schedule-day ${relative === '今天' ? 'is-today' : ''}"><div class="schedule-date"><span>${escapeHTML(date.slice(0, 7).replace('-', ' 年 '))} 月</span><strong>${Number(date.slice(8))}</strong><small>${weekday}${relative ? ` · ${relative}` : ''}</small></div><div class="schedule-day-events">${events.map(event => `<article class="schedule-card ${event.kind === 'deadline' ? 'is-deadline' : ''}"><div class="schedule-card-time"><span>${event.ongoing ? '进行中' : event.time || '时间未注明'}</span><small>${event.sourceType === 'task' ? (event.kind === 'deadline' ? '任务截止' : '任务计划') : event.kind === 'deadline' ? '截止' : '活动'} · ${event.eventType === 'recurring' ? '周期' : '一次性'}${event.status === 'done' ? ' · 已完成' : ''}</small></div><div class="schedule-card-body"><button type="button" class="schedule-open" data-action="open-event" data-source="${escapeHTML(event.sourceType || 'notice')}" data-id="${escapeHTML(event.sourceType === 'task' ? event.taskId : event.sourceType === 'event' ? event.eventId : event.noticeId)}">${escapeHTML(event.title)}${icon('arrow')}</button><p class="schedule-origin">${event.sourceType === 'task' ? '' : `${participationLabel(event)} · `}${escapeHTML(event.noticeTitle || (event.sourceType === 'task' ? '个人任务' : event.recordType === 'course' ? '课程' : '事件'))} · ${escapeHTML(event.sourceName || '来源未注明')}</p>${event.endDate || event.endTime || event.ongoing ? `<p class="schedule-duration">${escapeHTML(eventDateLabel(event))}</p>` : ''}${event.location ? `<p class="schedule-location">地点：${escapeHTML(event.location)}</p>` : ''}${event.sourceType === 'event' && event.eventType === 'recurring' ? `<button class="text-button schedule-adjust" type="button" data-action="adjust-occurrence" data-id="${escapeHTML(event.eventId)}" data-date="${escapeHTML(event.occurrenceDate)}">仅调整这一次</button>` : ''}${event.evidence ? `<details class="schedule-evidence"><summary>日期依据</summary><p>${escapeHTML(event.evidence)}</p></details>` : ''}</div></article>`).join('')}</div></section>`;
  }).join('') : `<div class="schedule-empty">${icon('clock')}<h3>这段时间没有已记录的${kind === 'event' ? '活动' : kind === 'deadline' ? '截止事项' : '事项'}</h3><p>可调整日期范围，或在事件的“事件时间”中补充明确的安排。</p><button type="button" class="button secondary" data-view="all">回到事件库</button></div>`;
  const unrecorded = notices.filter(notice => !notice.deadline && !notice.events.length).length;
  $('schedule-note').textContent = `周期事件按有效日期逐次显示；“资料信息”不代表你已参加，“已纳入安排”表示个人确定的安排。${unrecorded ? `另有 ${unrecorded} 条事件尚未记录明确时间，可回到事件库补充。` : ''}`;
}

async function loadSchedule() {
  if (document.body.dataset.auth !== 'email' || state.view !== 'schedule') return;
  const { from, to, kind, type } = scheduleState;
  const signature = JSON.stringify([from, to, kind, type]);
  if (scheduleInFlight === signature) return;
  scheduleInFlight = signature;
  const generation = ++scheduleGeneration;
  try {
    const entries = []; let offset = 0, page;
    do {
      page = await api('GET', undefined, `/api/events?${new URLSearchParams({ from, to, kind, type, limit: '200', offset: String(offset) })}`);
      entries.push(...page.events); offset += page.events.length;
    } while (page.hasMore && generation === scheduleGeneration);
    if (generation !== scheduleGeneration || state.view !== 'schedule') return;
    const changed = !scheduleResult || JSON.stringify(entries) !== JSON.stringify(scheduleResult.events);
    scheduleResult = { ...page, events: entries };
    $('schedule-error').hidden = true;
    if (changed) renderSchedule();
  } catch (error) {
    if (generation !== scheduleGeneration) return;
    $('schedule-error').textContent = error.message; $('schedule-error').hidden = false;
    $('schedule-summary').textContent = '时间表读取失败，请调整范围或点击立即刷新。';
  } finally { if (generation === scheduleGeneration) scheduleInFlight = ''; }
}

function applyScheduleRange(from, to, preset = null) {
  try {
    Schedule.collect([], from, to);
    scheduleState.from = from; scheduleState.to = to; scheduleState.preset = preset;
    $('schedule-error').hidden = true; renderSchedule();
  } catch (error) { $('schedule-error').textContent = error.message; $('schedule-error').hidden = false; }
}
$('schedule-range').addEventListener('submit', event => { event.preventDefault(); applyScheduleRange($('schedule-from').value, $('schedule-to').value); });
document.querySelectorAll('.range-preset').forEach(button => button.addEventListener('click', () => { const days = Number(button.dataset.days); applyScheduleRange(Schedule.today(), Schedule.shiftDay(Schedule.today(), days - 1), days); }));
$('schedule-kind').addEventListener('change', event => { scheduleState.kind = event.target.value; renderSchedule(); });
$('schedule-type').addEventListener('change', event => { scheduleState.type = event.target.value; renderSchedule(); });

const EventEditor = globalThis.ZhihuiEventEditor;
let formContext = { source: 'notice', record: null, recordType: 'schedule' };
$('add-event').addEventListener('click', () => {
  if ($('event-fields').children.length >= 50) { toast('每条事件最多记录 50 个时间事项。'); return; }
  $('event-fields').insertAdjacentHTML('beforeend', EventEditor.fields());
  EventEditor.sync($('event-fields').lastElementChild);
});
$('event-fields').addEventListener('click', event => { const button = event.target.closest('[data-remove-event]'); if (button) button.closest('.event-field-row').remove(); });

function renderRuleDetail(event) {
  const category = categoryStyle(event.category), next = event.nextOccurrence;
  const adjusted = next && next.eventId !== event.id;
  const course = event.recordType === 'course', label = course ? '课程' : '事件';
  $('detail-panel').innerHTML = `<div class="detail-heading"><span>${icon(course ? 'book' : 'clock')}${label}详情</span><span>${event.active === false ? '已取消' : event.scheduleStatus === 'undated' ? '时间待定' : event.scheduleStatus === 'ended' ? '已结束' : participationLabel(event)}</span></div><div class="detail-body"><div class="detail-topline"><span class="category-badge" style="color:${category.color};background:${category.background}">${escapeHTML(categoryLabel(event.category))}</span><span class="inbox-type-tag ${course ? 'course' : event.recurrence ? 'recurring' : 'once'}">${course ? `课程 · ${event.recurrence ? '周期' : '一次性'}` : event.recurrence ? '每周重复事件' : '事件'}</span></div><h2>${escapeHTML(event.title)}</h2><div class="detail-summary">${escapeHTML(ruleLabel(event))}</div><p class="inbox-next">${escapeHTML(nextLabel(event))}</p><dl class="detail-meta"><dt>地点</dt><dd>${escapeHTML(next?.location || event.location || '未注明')}</dd><dt>有效日期</dt><dd>${escapeHTML(event.date || '未注明')}${event.recurrence ? ` 至 ${escapeHTML(event.recurrence.until)}` : event.endDate ? ` 至 ${escapeHTML(event.endDate)}` : ''}</dd><dt>来源</dt><dd>${escapeHTML(event.sourceName || '未注明')}</dd></dl>${event.sourceUrl ? `<a class="source-link" href="${escapeHTML(safeURL(event.sourceUrl))}" target="_blank" rel="noopener noreferrer">查看原文链接${icon('link')}</a>` : ''}${event.notes ? `<div class="content-divider">补充说明</div><p class="original-content">${escapeHTML(event.notes)}</p>` : ''}${event.sourceText ? `<div class="content-divider">来源原文</div><p class="original-content">${escapeHTML(event.sourceText)}</p>` : ''}<p class="notice-reference">事件编号：${escapeHTML(event.id)}</p><div class="inbox-rule-actions"><button class="button secondary" data-action="edit-rule" data-id="${escapeHTML(event.id)}">${event.recurrence ? '编辑整个系列' : `编辑${label}`}</button>${event.active !== false && next && event.recurrence ? `<button class="button secondary" data-action="${adjusted ? 'edit-rule' : 'adjust-occurrence'}" data-id="${escapeHTML(adjusted ? next.eventId : event.id)}" data-date="${escapeHTML(next.occurrenceDate)}">${adjusted ? '编辑这次调课' : '调整下一次'}</button>` : ''}<button class="text-button" data-action="toggle-rule" data-id="${escapeHTML(event.id)}">${event.active === false ? `恢复${label}` : event.recurrence ? '取消整个系列' : `取消${label}`}</button></div></div>`;
}
function renderDetail() {
  const event = eventRules.find(event => `event:${event.id}` === state.selected);
  if (event) { renderRuleDetail(event); return; }
  const n = notices.find(n => `notice:${n.id}` === state.selected);
  if (!n) { $('detail-panel').innerHTML = `<div class="detail-heading"><span>${icon('file')}事件详情</span></div><div class="detail-empty">${icon('file')}<p>选择一条事件<br>在这里查看完整内容。</p></div>`; return; }
  const category = categoryStyle(n.category);
  const deadlineDate = entryDeadline({ ...n, entrySource: 'notice' }), deadline = deadlineLabel({ deadline: deadlineDate });
  const fields = [['发布单位', n.sourceName], ['发布日期', n.publishedAt], ['适用对象', n.audience], ['地点', n.location]];
  $('detail-panel').innerHTML = `<div class="detail-heading"><span>${icon('file')}事件详情</span></div><div class="detail-body"><div class="detail-topline"><span class="category-badge" style="color:${category.color};background:${category.background}">${escapeHTML(categoryLabel(n.category))}</span>${n.importedBy === 'agent' ? '<span class="agent-badge">Agent 导入</span>' : ''}${n.isDemo ? '<span class="sample-badge">自编示例</span>' : ''}<span class="participation-tag">${participationLabel(n)}</span></div><h2>${escapeHTML(n.title)}</h2>${deadlineDate ? `<div class="detail-deadline deadline-badge ${deadline.style}">${icon('clock')}${escapeHTML(deadline.label)}<small>${escapeHTML(deadlineDate)}</small></div>` : ''}${n.summary ? `<div class="detail-summary">${escapeHTML(n.summary)}</div>` : ''}<dl class="detail-meta">${fields.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${escapeHTML(value)}</dd>`).join('')}</dl><div class="content-divider">事件原文</div><p class="original-content">${escapeHTML(n.content || '未填写原文，可在编辑中补充。')}</p>${n.sourceUrl ? `<a class="source-link" href="${escapeHTML(safeURL(n.sourceUrl))}" target="_blank" rel="noopener noreferrer">查看原文链接${icon('link')}</a>` : ''}<p class="notice-reference">事件编号：${escapeHTML(n.id)}</p><div class="detail-actions"><button class="text-button" data-action="toggle" data-id="${escapeHTML(n.id)}">${n.active === false ? '恢复事件' : '取消事件'}</button><button class="icon-button" data-action="edit" data-id="${escapeHTML(n.id)}" aria-label="编辑事件" title="编辑事件">${icon('edit')}</button><button class="icon-button" data-action="delete" data-id="${escapeHTML(n.id)}" aria-label="删除事件" title="删除事件">${icon('trash')}</button></div></div>`;
  if (document.body.dataset.auth === 'email') $('detail-panel').querySelector('.detail-actions').insertAdjacentHTML('beforebegin', `<button class="button secondary notice-task-button" data-action="create-task" data-id="${escapeHTML(n.id)}">加入个人任务</button>`);
  if (n.events.length) $('detail-panel').querySelector('.content-divider').insertAdjacentHTML('beforebegin', `<ul class="detail-event-list">${n.events.map(event => `<li><strong>${escapeHTML(event.title)} · ${event.kind === 'deadline' ? '截止' : '活动'}</strong>${escapeHTML(ruleLabel(event))}</li>`).join('')}</ul>`);
}

function setCategories(names) {
  CATEGORIES = names.map(name => categoryStyle(name));
  globalThis.ZhihuiPlanner.setCategories(names);
  if (state.category && !names.includes(state.category)) state.category = '';
  const select = $('notice-form').elements.namedItem('category'), previous = select.value;
  const removed = $('notice-dialog').open && previous && !names.includes(previous);
  select.innerHTML = names.map(name => `<option value="${escapeHTML(name)}">${escapeHTML(categoryLabel(name))}</option>`).join('') + (removed ? `<option value="${escapeHTML(previous)}">${escapeHTML(previous)}（已移除，请重新选择）</option>` : '');
  select.value = removed || names.includes(previous) ? previous : '其他通知';
}

const categoryRequest = (method, body) => api(method, body, '/api/categories');
function renderCategoryManager() {
  $('category-list').innerHTML = CATEGORIES.map(({ name }) => {
    const count = listEntries(true).filter(n => n.category === name).length;
    return `<form class="category-manager-row" data-name="${escapeHTML(name)}"><label class="field"><span>${count} 条事件${name === '其他通知' ? ' · 保留分类' : ''}</span><input name="newName" value="${escapeHTML(categoryLabel(name))}" required maxlength="30" aria-label="分类名称：${escapeHTML(categoryLabel(name))}" ${name === '其他通知' ? 'readonly' : ''}></label>${name === '其他通知' ? '<span class="category-reserved">用于接收未分类事件</span>' : `<button type="submit" class="button secondary">保存名称</button><button type="button" class="text-button" data-delete-category="${escapeHTML(name)}" aria-label="删除分类：${escapeHTML(name)}">删除</button>`}</form>`;
  }).join('');
}
async function changeCategory(button, method, body) {
  await writeNotices(button, async () => {
    const result = await categoryRequest(method, body);
    if (method !== 'POST') {
      const nextName = method === 'PATCH' ? body.newName.trim() : '其他通知';
      notices = notices.map(n => n.category === body.name ? { ...n, category: nextName } : n);
      eventRules = eventRules.map(n => n.category === body.name ? { ...n, category: nextName } : n);
      if (state.category === body.name) state.category = nextName;
    } else $('category-name').value = '';
    setCategories(result.categories); render(); renderCategoryManager();
    toast(method === 'POST' ? '分类已添加' : method === 'PATCH' ? '分类名称和已有事件已同步更新' : '分类已删除，事件已移到“其他事件”');
  });
}
$('manage-categories').addEventListener('click', () => { renderCategoryManager(); $('category-dialog').showModal(); $('category-name').focus(); });
$('close-categories').addEventListener('click', () => $('category-dialog').close());
$('category-form').addEventListener('submit', event => { event.preventDefault(); changeCategory(event.submitter, 'POST', { name: $('category-name').value }); });
$('category-list').addEventListener('submit', event => {
  event.preventDefault();
  changeCategory(event.submitter, 'PATCH', { name: event.target.dataset.name, newName: event.target.elements.namedItem('newName').value });
});
$('category-list').addEventListener('click', event => {
  const button = event.target.closest('[data-delete-category]');
  if (!button) return;
  const name = button.dataset.deleteCategory, count = listEntries(true).filter(n => n.category === name).length;
  if (count && !confirm(`删除“${name}”分类？其中 ${count} 条事件会移到“其他事件”，事件内容会保留。`)) return;
  changeCategory(button, 'DELETE', { name });
});

async function openForm(id = null, source = 'notice', defaults = {}) {
  let record = id ? source === 'event' ? (await api('GET', undefined, '/api/event-rules')).events.find(event => event.id === id) : (await api()).notices.find(notice => notice.id === id) : null;
  if (id && !record) throw new Error('事件不存在，请刷新后重试。');
  if (record && source === 'notice') record = normalizeNotice(record);
  formContext = { source, record, recordType: record?.recordType || defaults.recordType || 'schedule' };
  const form = $('notice-form'), field = name => form.elements.namedItem(name);
  form.reset(); state.editing = id;
  $('dialog-title').textContent = id ? '编辑事件' : '添加事件';
  for (const name of ['title', 'location', 'sourceName', 'sourceUrl', 'publishedAt', 'audience']) field(name).value = record?.[name] || '';
  field('recordType').value = formContext.recordType;
  field('recordType').disabled = !!record?.seriesId;
  field('category').value = record?.category || defaults.category || state.category || (formContext.recordType === 'course' ? courseCategory : '其他通知');
  field('category').disabled = !!record?.seriesId;
  field('participation').checked = record ? (record.participation || (source === 'event' ? 'planned' : 'reference')) === 'planned' : defaults.recordType === 'course';
  field('participation').disabled = !!record?.seriesId;
  field('description').value = record ? source === 'event' ? record.notes || '' : record.summary || '' : '';
  field('description').maxLength = source === 'event' ? 20000 : 240;
  field('content').value = record ? source === 'event' ? record.sourceText || '' : record.content || '' : '';
  $('event-extra-meta').hidden = source === 'event';
  $('event-series-note').hidden = !record?.seriesId;
  $('event-form-error').hidden = true;
  $('event-source').open = !!(field('content').value || field('sourceName').value || field('sourceUrl').value || field('publishedAt').value || field('audience').value);
  let times = record ? source === 'event' ? [record] : record.events.map(event => ({ ...event })) : defaults.recurring ? [{ recurrence: { until: '', weekdays: [], weeks: [], intervalWeeks: 1, excludeDates: [] } }] : [];
  let legacyIndex = -1;
  if (source === 'notice' && record?.deadline) {
    legacyIndex = times.findIndex(event => event.kind === 'deadline' && event.date === record.deadline);
    if (legacyIndex < 0) { legacyIndex = times.length; formContext.syntheticDeadline = true; times.push({ title: `${record.title} · 截止`, date: record.deadline, kind: 'deadline' }); }
  }
  $('event-time-details').open = times.length > 0;
  $('event-fields').innerHTML = (times.length ? times : [{}]).map(EventEditor.fields).join('');
  EventEditor.hydrate($('event-fields'));
  if (legacyIndex >= 0) { const row = $('event-fields').children[legacyIndex]; row.dataset.legacyDeadline = 'true'; if (formContext.syntheticDeadline) row.dataset.syntheticDeadline = 'true'; }
  $('add-event').hidden = source === 'event';
  if (source === 'event') {
    $('event-fields').querySelectorAll('[data-remove-event]').forEach(button => { button.hidden = true; });
    $('event-fields').querySelector('[data-event-field="title"]').closest('label').hidden = true;
  }
  $('notice-dialog').showModal(); field('title').focus();
}

$('notice-form').addEventListener('change', event => {
  if (event.target.name !== 'recordType') return;
  const field = name => $('notice-form').elements.namedItem(name), previous = formContext.recordType;
  const oldDefault = previous === 'course' ? courseCategory : formContext.source === 'event' ? scheduleCategory : '其他通知';
  if (field('category').value === oldDefault) field('category').value = event.target.value === 'course' ? courseCategory : formContext.source === 'event' ? scheduleCategory : '其他通知';
  formContext.recordType = event.target.value;
});

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) { state.view = button.dataset.view; state.category = ''; state.type = 'all'; state.repeat = 'all'; $('inbox-type').value = 'all'; $('inbox-repeat').value = 'all'; render(); return; }
  if (button.dataset.category) { if (['schedule', 'tasks', 'events', 'preferences', 'review'].includes(state.view)) state.view = 'all'; state.category = state.category === button.dataset.category ? '' : button.dataset.category; render(); return; }
  const action = button.dataset.action;
  if (action === 'clear-category') { state.category = ''; render(); return; }
  if (!action) return;
  if (['select-rule', 'edit-rule', 'favorite-rule', 'toggle-rule'].includes(action)) {
    const rule = eventRules.find(event => event.id === button.dataset.id);
    if (action === 'select-rule') { state.selected = `event:${button.dataset.id}`; render(); if (innerWidth <= 1000) $('detail-panel').scrollIntoView({ behavior: 'instant', block: 'nearest' }); }
    if (action === 'edit-rule') { try { await globalThis.ZhihuiPlanner.openEvent(button.dataset.id); } catch (error) { toast(error.message); } }
    if (rule && ['favorite-rule', 'toggle-rule'].includes(action)) await writeNotices(button, async () => {
      const latest = (await api('GET', undefined, '/api/event-rules')).events.find(event => event.id === rule.id);
      if (!latest) throw new Error('日程不存在，请刷新后重试。');
      await api('PATCH', { id: latest.id, expectedVersion: latest.version, patch: action === 'favorite-rule' ? { favorite: !latest.favorite } : { active: latest.active === false } }, '/api/events');
      toast(action === 'favorite-rule' ? latest.favorite ? '已取消收藏' : '已收藏事件' : latest.active === false ? '事件已恢复' : '事件已取消，可勾选“显示已取消安排”恢复');
    });
    return;
  }
  if (action === 'adjust-occurrence') { try { await globalThis.ZhihuiPlanner.openOccurrence(button.dataset.id, button.dataset.date); } catch (error) { toast(error.message); } return; }
  if (action === 'open-event' && button.dataset.source && button.dataset.source !== 'notice') { try { await globalThis.ZhihuiPlanner[button.dataset.source === 'task' ? 'openTask' : 'openEvent'](button.dataset.id); } catch (error) { toast(error.message); } return; }
  const n = notices.find(n => n.id === button.dataset.id);
  if (!n) return;
  if (action === 'create-task') { globalThis.ZhihuiPlanner.newTask({ title: n.title, noticeId: n.id, dueDate: n.deadline }); return; }
  if (action === 'open-event') { state.view = 'all'; state.category = ''; state.query = ''; $('search').value = ''; state.selected = `notice:${n.id}`; render(); $('detail-panel').scrollIntoView({ behavior: 'instant', block: 'nearest' }); }
  if (action === 'select') { state.selected = `notice:${n.id}`; render(); if (innerWidth <= 1000) $('detail-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); }
  if (action === 'favorite') await writeNotices(button, () => api('PATCH', { id: n.id, patch: { favorite: !n.favorite } }));
  if (action === 'toggle') await writeNotices(button, () => api('PATCH', { id: n.id, patch: { active: n.active === false } }));
  if (action === 'edit') { try { await openForm(n.id); } catch (error) { toast(error.message); } }
  if (action === 'delete') {
    await writeNotices(button, async () => {
      await api('DELETE', { ids: [n.id] });
      toast('事件已删除', () => writeNotices(null, async () => { await api('POST', { notices: [n] }); state.selected = `notice:${n.id}`; toast('已恢复事件'); }));
    });
  }
});

$('add-notice').addEventListener('click', () => { if (!serverReady) { toast('请先连接事件库。'); return; } openForm(); });
['close-dialog', 'cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('notice-dialog').close()));
$('notice-form').addEventListener('submit', async event => {
  event.preventDefault();
  await writeNotices($('save-notice'), async () => {
    try {
      const field = name => $('notice-form').elements.namedItem(name), { source, record } = formContext;
      const title = field('title').value.trim(), values = [...$('event-fields').children].map(row => ({ row, value: EventEditor.read(row) }));
      const rawTimes = values.filter(item => item.value && !(item.row.dataset.syntheticDeadline && item.value.kind === 'deadline' && !item.value.recurrence)).map(({ value }) => ({ ...value, title: value.title || title }));
      const recordType = record?.seriesId ? record.recordType : field('recordType').value;
      const category = record?.seriesId ? record.category : field('category').value;
      const participation = record?.seriesId ? record.participation || 'planned' : field('participation').checked ? 'planned' : 'reference';
      if (!CATEGORIES.some(item => item.name === category)) throw new Error('分类已变更，请重新打开编辑窗口后选择分类。');
      let selected;
      if (source === 'event') {
        const time = rawTimes[0] || { date: '', time: '', endDate: '', endTime: '', kind: record.kind || 'event', recurrence: null, evidence: '' };
        const patch = { ...time, title, recordType, category, participation, location: field('location').value, notes: field('description').value, sourceName: field('sourceName').value, sourceUrl: field('sourceUrl').value, sourceText: field('content').value };
        globalThis.ZhihuiEventRules.normalizeEvent(patch);
        await api('PATCH', { id: record.id, expectedVersion: record.version, patch }, '/api/events');
        selected = `event:${record.id}`;
      } else {
        const marked = values.find(item => item.row.dataset.legacyDeadline)?.value;
        const fields = { title, category, recordType, participation, summary: field('description').value, location: field('location').value, content: field('content').value, sourceName: field('sourceName').value, sourceUrl: field('sourceUrl').value, publishedAt: field('publishedAt').value, audience: field('audience').value, deadline: marked?.kind === 'deadline' && !marked.recurrence ? marked.date : '', events: Schedule.normalizeEvents(rawTimes), isDemo: false };
        if (record) { await api('PATCH', { id: record.id, expectedUpdatedAt: record.updatedAt, patch: fields }); selected = `notice:${record.id}`; }
        else {
          const result = await api('POST', { notices: [normalizeNotice({ ...fields, id: crypto.randomUUID() })] });
          selected = `notice:${result.created?.[0]?.id || result.duplicates?.[0]?.id}`;
          if (result.skipped) toast('事件已存在，已跳过重复记录');
        }
      }
      state.selected = selected; state.view = 'all'; state.category = ''; state.query = ''; state.type = 'all'; state.repeat = 'all';
      $('search').value = ''; $('inbox-type').value = 'all'; $('inbox-repeat').value = 'all';
      $('notice-dialog').close(); toast(record ? '事件已更新' : '事件已保存');
      if (state.view === 'schedule') loadSchedule();
    } catch (error) { $('event-form-error').textContent = error.message; $('event-form-error').hidden = false; throw error; }
  });
});
$('search').addEventListener('input', (event) => { state.query = event.target.value.trim(); render(); });
$('sort').addEventListener('change', (event) => { state.sort = event.target.value; render(); });
$('inbox-type').addEventListener('change', event => { state.type = event.target.value; render(); });
$('inbox-repeat').addEventListener('change', event => { state.repeat = event.target.value; render(); });
$('inbox-cancelled').addEventListener('change', event => { state.showCancelled = event.target.checked; render(); });
$('empty-action').addEventListener('click', event => {
  if (state.query || state.category || state.view !== 'all' || state.type !== 'all' || state.repeat !== 'all') { state.query = ''; state.category = ''; state.view = 'all'; state.type = 'all'; state.repeat = 'all'; $('search').value = ''; $('inbox-type').value = 'all'; $('inbox-repeat').value = 'all'; render(); } else { event.stopPropagation(); openForm(); }
});
$('remove-examples').addEventListener('click', async () => {
  const removed = notices.filter(n => n.isDemo);
  await writeNotices($('remove-examples'), async () => {
    for (let i = 0; i < removed.length; i += 50) await api('DELETE', { ids: removed.slice(i, i + 50).map(n => n.id) });
    toast('示例事件已移除', () => writeNotices(null, async () => { await importBatches(removed); toast('已恢复示例事件'); }));
  });
});
$('undo-button').addEventListener('click', () => { const action = undoAction; undoAction = null; action?.(); });
$('export-button').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), categories: CATEGORIES.map(c => c.name), notices }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `知会事件备份-${localDay()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('普通事件原文已导出；完整备份请在停止程序后复制 data 文件夹。');
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('备份文件请控制在 2 MB 以内。');
    const imported = JSON.parse(await file.text());
    if (imported.version !== 1 || !Array.isArray(imported.notices)) throw new Error('请选择知会导出的 JSON 备份文件。');
    const incoming = imported.notices.map(normalizeNotice);
    const names = [...new Set([...(Array.isArray(imported.categories) ? imported.categories : []), ...incoming.map(n => n.category)])];
    if (names.some(name => typeof name !== 'string' || !name.trim() || name.trim().length > 30 || /[\u0000-\u001f\u007f]/.test(name))) throw new Error('备份中的分类名称必须为 1—30 个字符，不能含换行。');
    if (new Set([...CATEGORIES.map(c => c.name), ...names.map(name => name.trim())]).size > 30) throw new Error('导入后分类将超过 30 个，请先整理分类。');
    await writeNotices($('import-button'), async () => {
      for (const name of names.map(name => name.trim())) {
        if (!CATEGORIES.some(c => c.name === name)) setCategories((await categoryRequest('POST', { name })).categories);
      }
      const result = await importBatches(incoming); toast(`已保存 ${result.imported} 条事件，跳过 ${result.skipped} 条已有记录`);
    });
  } catch (error) { toast(error instanceof SyntaxError ? '文件不是有效的 JSON，请检查备份。' : error.message); }
  event.target.value = '';
});
$('today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
if (legacyNotices.length) {
  $('migration-banner').hidden = false;
  $('migration-message').textContent = `本浏览器有 ${legacyNotices.length} 条旧版事件，可以迁移到当前登录的账号。原有本地数据会保留。`;
}
$('migrate-notices').addEventListener('click', () => writeNotices($('migrate-notices'), async () => {
  const result = await importBatches(legacyNotices);
  $('migration-banner').hidden = true;
  toast(`迁移完成：保存 ${result.imported} 条，跳过 ${result.skipped} 条重复事件`);
}));
$('refresh-notices').addEventListener('click', () => { refreshNotices(true); if (state.view === 'schedule') loadSchedule(); else globalThis.ZhihuiPlanner.refresh(); });
$('connect-agent').addEventListener('click', () => { if (document.body.dataset.auth === 'email') { document.dispatchEvent(new Event('notice:connect-agent')); return; } $('mcp-address').value = `${location.origin}/mcp`; $('agent-dialog').showModal(); });
$('close-agent').addEventListener('click', () => $('agent-dialog').close());
$('copy-mcp').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('mcp-address').value); toast('服务地址已复制'); } catch { $('mcp-address').select(); toast('请复制选中的服务地址'); } });
document.addEventListener('planner:message', event => toast(event.detail));
document.addEventListener('planner:changed', event => {
  noticeGeneration++;
  if (event.detail?.created && event.detail.eventId) { state.view = 'all'; state.category = ''; state.query = ''; state.type = 'all'; state.selected = `event:${event.detail.eventId}`; $('search').value = ''; $('inbox-type').value = 'all'; }
  if (state.view === 'schedule') loadSchedule();
  refreshNotices();
});
if (document.body.dataset.auth === 'email') document.querySelectorAll('[data-planner-nav]').forEach(button => { button.hidden = false; });
globalThis.ZhihuiPlanner.setEventEditor(({ id, source, ...defaults }) => openForm(id || null, source || 'notice', defaults));
globalThis.ZhihuiPlanner.setDefaultCategories(scheduleCategory, courseCategory);
setCategories(CATEGORIES.map(category => category.name));
render();
refreshNotices();
setInterval(() => { if (!document.hidden) { refreshNotices(); if (state.view === 'schedule') loadSchedule(); else globalThis.ZhihuiPlanner.refresh(); } }, 5000);
// 午夜后或重新回到页面时，刷新截止状态。
setInterval(render, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { render(); refreshNotices(); } });
