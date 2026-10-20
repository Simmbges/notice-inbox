import { categories, InputError, normalizeEvents, noticeDefaults } from '../lib/notice-input.ts';

const timeZone = 'Asia/Shanghai';
const shiftDate = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const context = () => ({ today: new Date().toLocaleDateString('sv-SE', { timeZone }), timeZone });

function checkArguments(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new InputError('查询参数不正确，请只传工具支持的字段。');
}

function checkDate(value, name) {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new InputError(`${name} 必须是有效的 YYYY-MM-DD 日期。`);
}

export async function agentList(db, owner, arguments_ = {}, categoryNames = categories) {
  checkArguments(arguments_, ['query', 'category', 'deadlineFrom', 'deadlineTo', 'deadlineWindow', 'sort', 'limit', 'offset']);
  const { query = '', category, deadlineWindow, sort = 'newest', limit = 20, offset = 0 } = arguments_;
  let { deadlineFrom = '', deadlineTo = '' } = arguments_;
  if (typeof query !== 'string' || query.length > 200) throw new InputError('搜索关键词必须为不超过 200 个字符的文本。');
  if (category !== undefined && !categoryNames.includes(category)) throw new InputError(`请选择已有分类：${categoryNames.join('、')}。`);
  if (!['newest', 'deadline'].includes(sort)) throw new InputError('排序只支持 newest 或 deadline。');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50 || !Number.isSafeInteger(offset) || offset < 0) throw new InputError('limit 须为 1—50 的整数，offset 须为非负整数。');
  checkDate(deadlineFrom, 'deadlineFrom'); checkDate(deadlineTo, 'deadlineTo');
  const clock = context();
  if (deadlineWindow !== undefined) {
    if (!['today', 'next_7_days', 'this_week'].includes(deadlineWindow) || deadlineFrom || deadlineTo) throw new InputError('deadlineWindow 请选择 today、next_7_days 或 this_week，且不要同时传具体日期范围。');
    deadlineFrom = clock.today;
    deadlineTo = shiftDate(clock.today, deadlineWindow === 'next_7_days' ? 6 : 0);
    if (deadlineWindow === 'this_week') {
      const weekday = (new Date(`${clock.today}T00:00:00Z`).getUTCDay() + 6) % 7;
      deadlineFrom = shiftDate(clock.today, -weekday); deadlineTo = shiftDate(deadlineFrom, 6);
    }
  }
  if (deadlineFrom && deadlineTo && deadlineFrom > deadlineTo) throw new InputError('截止日期范围的开始不能晚于结束。');
  const where = ['owner_id = ?'], values = [owner];
  if (query.trim()) {
    where.push("instr(lower(json_extract(data, '$.title') || char(10) || json_extract(data, '$.content') || char(10) || json_extract(data, '$.summary') || char(10) || json_extract(data, '$.sourceName')), lower(?)) > 0");
    values.push(query.trim());
  }
  if (category !== undefined) { where.push("json_extract(data, '$.category') = ?"); values.push(category); }
  if (deadlineFrom || deadlineTo) where.push("json_extract(data, '$.deadline') != ''");
  if (deadlineFrom) { where.push("json_extract(data, '$.deadline') >= ?"); values.push(deadlineFrom); }
  if (deadlineTo) { where.push("json_extract(data, '$.deadline') <= ?"); values.push(deadlineTo); }
  const clause = where.join(' AND ');
  const { total } = await db.prepare(`SELECT count(*) AS total FROM notices WHERE ${clause}`).bind(...values).first();
  const order = sort === 'deadline' ? "(json_extract(data, '$.deadline') = '') ASC, json_extract(data, '$.deadline') ASC, created_at DESC, id DESC" : 'created_at DESC, id DESC';
  const rows = await db.prepare(`SELECT data FROM notices WHERE ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...values, limit, offset).all();
  const notices = rows.results.map(({ data }) => {
    const { id, title, summary, category, sourceName, sourceUrl, publishedAt, deadline, audience, location, content, events, recordType, participation, active } = noticeDefaults(JSON.parse(data));
    return { id, title, summary, category, sourceName, sourceUrl, publishedAt, deadline, audience, location, recordType, participation, active, events: normalizeEvents(events), excerpt: (content || '').slice(0, 240) };
  });
  return { ...clock, categories: categoryNames, notices, total, limit, offset, hasMore: offset + notices.length < total, filters: { query: query.trim(), category: category ?? '', deadlineFrom, deadlineTo, sort } };
}

export async function agentGet(db, owner, arguments_) {
  checkArguments(arguments_, ['id']);
  const { id } = arguments_;
  if (typeof id !== 'string' || !id.trim() || id.length > 160) throw new InputError('请提供有效的事件编号。');
  const row = await db.prepare('SELECT data, updated_at FROM notices WHERE owner_id = ? AND id = ?').bind(owner, id).first();
  if (!row) throw new InputError('事件不存在或不属于当前账号。', 404);
  const notice = JSON.parse(row.data);
  return { ...context(), updatedAt: row.updated_at, notice: noticeDefaults({ ...notice, events: normalizeEvents(notice.events) }) };
}
