'use strict';

const STORAGE_KEY = 'campus-notice-inbox.v1';
const CATEGORIES = [
  { name: '课程学习', color: '#8187cc', background: '#eef0fc' },
  { name: '校园活动', color: '#6da990', background: '#ebf5ee' },
  { name: '竞赛报名', color: '#bf9068', background: '#faf0e7' },
  { name: '校园事务', color: '#9c85be', background: '#f2ecf9' },
  { name: '其他通知', color: '#8e99aa', background: '#eef1f5' }
];
const VIEW_NAMES = { all: '全部通知', unread: '未读通知', soon: '即将截止', favorites: '我的收藏' };
const state = { view: 'all', category: '', query: '', sort: 'newest', selected: null, editing: null };
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
const isSoon = (notice) => { const days = dayDifference(notice.deadline); return days !== null && days >= 0 && days <= 7; };
const safeURL = (value) => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const validDay = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && localDay(new Date(`${value}T12:00:00`)) === value;
let toastTimer;
let undoAction = null;

function demoNotices() {
  const examples = [
    ['课程学习', '高等数学：本周练习提交说明', '整理本周练习，提交前检查题号和文件命名。', '课程教学组', 2, '本通知为自编演示内容。\n\n请完成本周练习，并在截止日期前整理提交。文件命名建议包含课程名称、姓名和练习编号。\n\n实际要求请以你的课程通知为准。', '本课程学生', '课程学习平台'],
    ['校园活动', '周末读书交流：带一本想分享的书', '一次轻松的阅读分享，提前准备一个想讨论的问题。', '阅读社团', 4, '本通知为自编演示内容。\n\n活动内容：每位参与者分享一本书及一个印象深刻的片段。\n准备事项：带书或准备文字摘录。\n\n具体活动信息仅用于展示页面功能。', '感兴趣的同学', '校园活动空间'],
    ['竞赛报名', '学生创意作品展示征集', '提交作品简介与展示材料，分享一个真实完成的小项目。', '学生创新社团', 7, '本通知为自编演示内容。\n\n征集内容：学习工具、设计作品或小型实践项目。\n提交材料：作品简介、过程记录和成果展示。\n\n这不是实际赛事通知。', '在校学生', '线上提交'],
    ['校园事务', '图书借阅：记得检查到期时间', '查看个人借阅记录，及时处理需要归还或续借的图书。', '图书服务台', 1, '本通知为自编演示内容。\n\n请查看自己的借阅记录，确认图书到期时间。需要续借时，请按实际图书馆规则办理。', '借阅图书的同学', '图书馆'],
    ['课程学习', '小组课堂展示：分工与材料准备', '确认主讲、资料整合和演示设备，给排练留出时间。', '课程教师', 10, '本通知为自编演示内容。\n\n准备清单：\n1. 明确展示主题和分工。\n2. 整理引用来源与讲解材料。\n3. 完成一次排练并核对展示时长。', '课程小组成员', '课程教室'],
    ['其他通知', '校园学习资料整理小贴士', '把课程文件按名称和周次归档，回看时更容易找到。', '学习交流小组', null, '本通知为自编演示内容。\n\n可以尝试按课程建立文件夹，给资料使用一致的命名，并保存重要通知的原文。\n这是一条没有截止日期的信息示例。', '所有同学', '']
  ];
  return examples.map((e, i) => ({ id: `demo-${i + 1}`, category: e[0], title: e[1], summary: e[2], sourceName: e[3], deadline: e[4] === null ? '' : offsetDay(e[4]), content: e[5], audience: e[6], location: e[7], publishedAt: offsetDay(-i), sourceUrl: '', createdAt: Date.now() - i * 3600000, read: i === 4, favorite: i === 0 || i === 2, isDemo: true }));
}

function normalizeNotice(raw) {
  if (!raw || typeof raw.title !== 'string' || !raw.title.trim() || typeof raw.content !== 'string' || !raw.content.trim()) throw new Error('每条通知都需要标题和正文。');
  const text = (key, max = 20000) => typeof raw[key] === 'string' ? raw[key].trim().slice(0, max) : '';
  const deadline = text('deadline', 10), publishedAt = text('publishedAt', 10);
  if (!validDay(deadline) || !validDay(publishedAt)) throw new Error('通知日期格式需要为 YYYY-MM-DD，并且是有效日期。');
  const sourceUrl = text('sourceUrl', 2000);
  if (sourceUrl && !safeURL(sourceUrl)) throw new Error('原文链接需要使用 http:// 或 https://。');
  return { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 160) : crypto.randomUUID(), title: text('title', 120), content: text('content'), summary: text('summary', 240), category: CATEGORIES.some(c => c.name === raw.category) ? raw.category : '其他通知', sourceName: text('sourceName', 80), sourceUrl, deadline, publishedAt, audience: text('audience', 120), location: text('location', 120), createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(), read: raw.read === true, favorite: raw.favorite === true, isDemo: raw.isDemo === true };
}

function loadNotices() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === null) { const samples = demoNotices(); localStorage.setItem(STORAGE_KEY, JSON.stringify(samples)); return samples; }
    const values = JSON.parse(saved);
    if (!Array.isArray(values)) throw new Error();
    return values.map(normalizeNotice);
  } catch { setTimeout(() => toast('无法读取浏览器中的记录，可以导入备份恢复。'), 0); return []; }
}
let notices = loadNotices();

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notices)); return true; }
  catch { toast('浏览器未能保存，请导出备份。当前页面仍可查看。'); return false; }
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
  return { label: `${formatDay(notice.deadline)} 截止`, style: days <= 7 ? 'urgent' : '' };
}

function filteredNotices() {
  const query = state.query.toLowerCase();
  return notices.filter(n => (!state.category || n.category === state.category) && (state.view !== 'unread' || !n.read) && (state.view !== 'soon' || isSoon(n)) && (state.view !== 'favorites' || n.favorite) && (!query || [n.title, n.content, n.summary, n.sourceName, n.audience, n.location].some(v => v.toLowerCase().includes(query)))).sort((a, b) => state.sort === 'deadline' ? (a.deadline || '9999').localeCompare(b.deadline || '9999') || b.createdAt - a.createdAt : state.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt);
}

function render() {
  const counts = { all: notices.length, unread: notices.filter(n => !n.read).length, soon: notices.filter(isSoon).length, favorites: notices.filter(n => n.favorite).length };
  Object.entries(counts).forEach(([key, count]) => { $(`stat-${key}`).textContent = count; $(`nav-${key}`).textContent = count; });
  document.querySelectorAll('#view-nav [data-view]').forEach(button => { button.classList.toggle('active', button.dataset.view === state.view); button.setAttribute('aria-pressed', String(button.dataset.view === state.view)); });
  $('category-nav').innerHTML = CATEGORIES.map(c => `<button class="nav-item ${state.category === c.name ? 'active' : ''}" data-category="${c.name}" aria-pressed="${state.category === c.name}"><span class="category-dot" style="background:${c.color}"></span>${c.name}<span class="nav-count">${notices.filter(n => n.category === c.name).length}</span></button>`).join('');
  $('demo-banner').hidden = !notices.some(n => n.isDemo);
  const visible = filteredNotices();
  if (!visible.some(n => n.id === state.selected)) state.selected = visible[0]?.id ?? null;
  $('list-heading').textContent = VIEW_NAMES[state.view];
  $('result-count').textContent = `${visible.length} 条通知`;
  $('active-filter').hidden = !state.category;
  $('active-filter').innerHTML = state.category ? `${escapeHTML(state.category)}<button data-action="clear-category">清除筛选 ×</button>` : '';
  $('notice-list').innerHTML = visible.map(n => {
    const category = CATEGORIES.find(c => c.name === n.category), deadline = deadlineLabel(n);
    return `<article class="notice-card ${n.id === state.selected ? 'selected' : ''}"><button class="notice-open" data-action="select" data-id="${escapeHTML(n.id)}" aria-pressed="${n.id === state.selected}" aria-label="查看通知：${escapeHTML(n.title)}"><div class="card-top"><span class="category-badge" style="color:${category.color};background:${category.background}">${n.category}</span>${n.isDemo ? '<span class="sample-badge">示例</span>' : ''}${!n.read ? '<span class="unread-dot" title="未读"></span>' : ''}</div><h3>${escapeHTML(n.title)}</h3><p class="card-summary">${escapeHTML(n.summary || n.content)}</p><div class="card-footer"><span class="card-source">${icon('file')}<span>${escapeHTML(n.sourceName || '手动录入')}</span></span><span class="deadline-badge ${deadline.style}">${icon('clock')}${deadline.label}</span></div></button><button class="favorite-button ${n.favorite ? 'is-favorite' : ''}" data-action="favorite" data-id="${escapeHTML(n.id)}" title="${n.favorite ? '取消收藏' : '收藏通知'}" aria-label="${n.favorite ? '取消收藏' : '收藏通知'}：${escapeHTML(n.title)}" aria-pressed="${n.favorite}">${icon('star')}</button></article>`;
  }).join('');
  $('empty-state').hidden = visible.length > 0;
  const filtering = !!state.query || !!state.category || state.view !== 'all';
  $('empty-title').textContent = filtering ? '没有符合条件的通知' : '还没有通知';
  $('empty-description').textContent = filtering ? '换个关键词，或清除筛选再看看。' : '添加第一条通知，让信息有个固定的家。';
  $('empty-action').textContent = filtering ? '清除筛选' : '添加通知';
  renderDetail();
}

function renderDetail() {
  const n = notices.find(n => n.id === state.selected);
  if (!n) { $('detail-panel').innerHTML = `<div class="detail-heading"><span>${icon('file')}通知详情</span></div><div class="detail-empty">${icon('file')}<p>选择一条通知<br>在这里查看完整内容。</p></div>`; return; }
  const category = CATEGORIES.find(c => c.name === n.category);
  $('detail-panel').innerHTML = `<div class="detail-heading"><span>${icon('file')}通知详情</span><span>${n.read ? '已读' : '未读'}</span></div><div class="detail-body"><div class="detail-topline"><span class="category-badge" style="color:${category.color};background:${category.background}">${n.category}</span>${n.isDemo ? '<span class="sample-badge">自编示例</span>' : ''}</div><h2>${escapeHTML(n.title)}</h2>${n.summary ? `<div class="detail-summary">${escapeHTML(n.summary)}</div>` : ''}<dl class="detail-meta"><dt>发布单位</dt><dd>${escapeHTML(n.sourceName || '未注明')}</dd><dt>发布日期</dt><dd>${formatDay(n.publishedAt)}</dd><dt>截止日期</dt><dd class="${n.deadline ? 'deadline-emphasis' : ''}">${n.deadline ? `${escapeHTML(n.deadline)}${dayDifference(n.deadline) < 0 ? ' · 已截止' : ''}` : '未注明'}</dd><dt>适用对象</dt><dd>${escapeHTML(n.audience || '未注明')}</dd><dt>地点</dt><dd>${escapeHTML(n.location || '未注明')}</dd></dl><div class="content-divider">通知原文</div><p class="original-content">${escapeHTML(n.content)}</p>${n.sourceUrl ? `<a class="source-link" href="${escapeHTML(safeURL(n.sourceUrl))}" target="_blank" rel="noopener noreferrer">查看原文链接${icon('link')}</a>` : ''}<div class="detail-actions"><button class="button secondary" data-action="read" data-id="${escapeHTML(n.id)}">${icon(n.read ? 'mail' : 'check')}${n.read ? '标为未读' : '标为已读'}</button><button class="icon-button" data-action="edit" data-id="${escapeHTML(n.id)}" aria-label="编辑通知" title="编辑通知">${icon('edit')}</button><button class="icon-button" data-action="delete" data-id="${escapeHTML(n.id)}" aria-label="删除通知" title="删除通知">${icon('trash')}</button></div></div>`;
}

function openForm(id = null) {
  state.editing = id;
  const form = $('notice-form');
  form.reset();
  $('dialog-title').textContent = id ? '编辑通知' : '添加通知';
  if (id) { const notice = notices.find(n => n.id === id); for (const field of ['title', 'category', 'sourceName', 'summary', 'publishedAt', 'deadline', 'audience', 'location', 'sourceUrl', 'content']) form.elements.namedItem(field).value = notice[field]; }
  $('notice-dialog').showModal();
  form.elements.namedItem('title').focus();
}

document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) { state.view = button.dataset.view; state.category = ''; render(); return; }
  if (button.dataset.category) { state.category = state.category === button.dataset.category ? '' : button.dataset.category; render(); return; }
  const action = button.dataset.action;
  if (action === 'clear-category') { state.category = ''; render(); return; }
  if (!action) return;
  const n = notices.find(n => n.id === button.dataset.id);
  if (!n) return;
  if (action === 'select') { state.selected = n.id; render(); if (innerWidth <= 1000) $('detail-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' }); }
  if (action === 'favorite') { n.favorite = !n.favorite; persist(); render(); }
  if (action === 'read') { n.read = !n.read; persist(); render(); }
  if (action === 'edit') openForm(n.id);
  if (action === 'delete') {
    const index = notices.indexOf(n);
    notices.splice(index, 1);
    const saved = persist(); render();
    if (saved) toast('通知已删除', () => { notices.splice(Math.min(index, notices.length), 0, n); state.selected = n.id; persist(); render(); toast('已恢复通知'); });
  }
});

$('add-notice').addEventListener('click', () => openForm());
['close-dialog', 'cancel-dialog'].forEach(id => $(id).addEventListener('click', () => $('notice-dialog').close()));
$('notice-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const existing = notices.find(n => n.id === state.editing);
    const notice = normalizeNotice({ ...existing, ...fields, id: existing?.id || crypto.randomUUID(), isDemo: false });
    if (existing) notices[notices.indexOf(existing)] = notice; else notices.unshift(notice);
    state.selected = notice.id; state.view = 'all'; state.category = ''; state.query = ''; $('search').value = '';
    const saved = persist(); $('notice-dialog').close(); render();
    if (saved) toast(existing ? '通知已更新' : '通知已添加，已保存在当前浏览器');
  } catch (error) { toast(error.message); }
});
$('search').addEventListener('input', (event) => { state.query = event.target.value.trim(); render(); });
$('sort').addEventListener('change', (event) => { state.sort = event.target.value; render(); });
$('empty-action').addEventListener('click', () => {
  if (state.query || state.category || state.view !== 'all') { state.query = ''; state.category = ''; state.view = 'all'; $('search').value = ''; render(); } else openForm();
});
$('remove-examples').addEventListener('click', () => {
  const removed = notices.filter(n => n.isDemo); notices = notices.filter(n => !n.isDemo);
  const saved = persist(); render();
  if (saved) toast('示例通知已移除', () => { notices.push(...removed); persist(); render(); toast('已恢复示例通知'); });
});
$('undo-button').addEventListener('click', () => { const action = undoAction; undoAction = null; action?.(); });
$('export-button').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), notices }, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `知会通知备份-${localDay()}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('通知备份已导出');
});
$('import-button').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('备份文件请控制在 2 MB 以内。');
    const imported = JSON.parse(await file.text());
    if (imported.version !== 1 || !Array.isArray(imported.notices)) throw new Error('请选择知会导出的 JSON 备份文件。');
    const incoming = imported.notices.map(normalizeNotice);
    const known = new Set(notices.map(n => n.id));
    const fresh = incoming.filter(n => { if (known.has(n.id)) return false; known.add(n.id); return true; });
    notices.push(...fresh);
    const saved = persist(); render(); if (saved) toast(`已导入 ${fresh.length} 条通知，跳过 ${incoming.length - fresh.length} 条已有记录`);
  } catch (error) { toast(error instanceof SyntaxError ? '文件不是有效的 JSON，请检查备份。' : error.message); }
  event.target.value = '';
});
$('today-label').textContent = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
render();
// 午夜后或重新回到页面时，刷新截止状态。
setInterval(render, 60000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });
