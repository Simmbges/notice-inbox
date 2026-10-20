import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const text = (value, field) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} 不能为空。`); return value.trim(); };
const date = (value, field) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) throw new Error(`${field} 必须是有效的 YYYY-MM-DD。`);
  return value;
};
const safeUrl = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch { return ''; } };
const time = (value, field) => { if (value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`${field} 应为 HH:mm 或空字符串。`); };
const references = (item, field) => {
  const result = [];
  if (item.noticeId !== undefined && item.noticeId !== '') result.push({ label: '事件编号', id: text(item.noticeId, `${field}.noticeId`) });
  if (item.reference !== undefined) {
    if (!item.reference || !['event', 'task'].includes(item.reference.type)) throw new Error(`${field}.reference.type 应为 event 或 task。`);
    result.push({ label: item.reference.type === 'event' ? '日程编号' : '任务编号', id: text(item.reference.id, `${field}.reference.id`) });
  }
  if (!result.length) throw new Error(`${field} 需要真实 noticeId 或个人日程/任务 reference。`);
  return result;
};
const referenceHtml = item => item.references.map(reference => `<span>${reference.label}：${escape(reference.id)}</span>`).join('');
const isDeadline = event => event.kind === 'deadline' || event.kind.includes('截止');
const eventTime = event => {
  const start = event.time || '时间未注明';
  const end = event.endDate || event.date;
  const range = event.endDate || event.endTime;
  if (range && end !== event.date) return `${event.date} ${start} — ${end} ${event.endTime || '时间未注明'}`;
  return event.endTime ? `${start} — ${event.endTime}` : event.endDate ? `${start} — 结束时间未注明` : start;
};

export function renderTimeline(data) {
  const today = date(data.today, 'today'), from = date(data.from, 'from'), to = date(data.to, 'to');
  if (from > to) throw new Error('开始日期不能晚于结束日期。');
  if (data.timeZone !== 'Asia/Shanghai') throw new Error('timeZone 应使用知会返回的 Asia/Shanghai。');
  const title = text(data.title, 'title'), coverage = text(data.coverage, 'coverage');
  if (!Array.isArray(data.events) || !Array.isArray(data.undated)) throw new Error('events 和 undated 必须是数组。');
  const events = data.events.map(event => {
    date(event.date, 'event.date');
    for (const name of ['title', 'kind', 'evidence']) text(event[name], `event.${name}`);
    const identifiers = references(event, 'event');
    time(event.time, 'time'); time(event.endTime, 'endTime');
    if (event.endDate) date(event.endDate, 'event.endDate');
    const end = event.endDate || event.date;
    if (end < event.date) throw new Error('结束日期不能早于开始日期。');
    if (event.endTime && (!event.time || `${end}T${event.endTime}` <= `${event.date}T${event.time}`)) throw new Error('结束时分需要开始时分，且结束必须晚于开始。');
    if (isDeadline(event) && (event.endDate || event.endTime)) throw new Error('截止事项不能有结束范围。');
    if (event.date > to || end < from) throw new Error('时间事项超出展示日期范围。');
    return { ...event, references: identifiers, displayDate: event.date < from ? from : event.date };
  }).sort((a, b) => a.displayDate.localeCompare(b.displayDate) || a.date.localeCompare(b.date) || (a.time || '99:99').localeCompare(b.time || '99:99'));
  const undated = data.undated.map(item => {
    for (const name of ['title', 'reason']) text(item[name], `undated.${name}`);
    return { ...item, references: references(item, 'undated') };
  });
  const groups = new Map();
  for (const event of events) { if (!groups.has(event.displayDate)) groups.set(event.displayDate, []); groups.get(event.displayDate).push(event); }
  const days = [...groups].map(([day, items]) => {
    const difference = Math.round((Date.parse(day) - Date.parse(today)) / 86400000);
    const tag = difference === 0 ? '今天' : difference === 1 ? '明天' : difference < 0 ? '已过' : '';
    const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long', timeZone: 'UTC' }).format(new Date(day));
    return `<section class="day"><div class="date"><strong>${day.slice(5).replace('-', ' / ')}</strong><span>${weekday}${tag ? ` · ${tag}` : ''}</span></div><div class="items">${items.map(event => {
      const url = safeUrl(event.sourceUrl);
      const kind = event.kind === 'event' ? '活动' : event.kind === 'deadline' ? '截止' : event.kind;
      return `<article class="event ${isDeadline(event) ? 'deadline' : ''}"><div class="event-top"><span class="kind">${event.date < from ? '进行中 · ' : ''}${escape(kind)}</span><span class="time">${escape(eventTime(event))}</span></div><h2>${escape(event.title)}</h2>${event.detail ? `<p>${escape(event.detail)}</p>` : ''}${event.location ? `<p class="location">地点：${escape(event.location)}</p>` : ''}<div class="reference"><span>来源：${escape(event.sourceName || '来源未注明')}</span>${referenceHtml(event)}${url ? `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ''}</div><details><summary>日期依据</summary><p>${escape(event.evidence)}</p></details></article>`;
    }).join('')}</div></section>`;
  }).join('');
  const uncertain = undated.length ? `<section class="uncertain"><h2>时间待确认 <small>${undated.length} 条</small></h2><p>以下事项是否落在本次日期范围，尚待确认。</p>${undated.map(item => `<article><strong>${escape(item.title)}</strong><p>${escape(item.reason)}</p>${referenceHtml(item)}</article>`).join('')}</section>` : '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)} · 知会</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f4fa;color:#29273b;font-family:"Segoe UI","Microsoft YaHei",sans-serif;line-height:1.7}main{max-width:1000px;margin:0 auto;padding:40px 40px 60px}.brand{color:#6653bc;font-size:13px;font-weight:600;letter-spacing:2px}header{border-bottom:1px solid #ded9ec;padding-bottom:24px;margin-bottom:26px}h1{font-size:30px;margin:10px 0}header p{margin:8px 0;color:#676073}.summary{display:flex;gap:20px;font-size:14px}.coverage{font-size:13px;line-height:1.8}.day{display:grid;grid-template-columns:125px 1fr;gap:28px;margin-bottom:24px}.date{padding-top:14px}.date strong{font-size:24px;display:block}.date span{font-size:13px;color:#777082}.items{border-left:2px solid #d9d0f3;padding-left:25px;display:grid;gap:14px}.event{position:relative;background:white;border:1px solid #e4dff0;border-radius:14px;padding:20px 24px}.event:before{content:"";position:absolute;left:-33px;top:27px;width:12px;height:12px;background:#7962ca;border:3px solid #f5f4fa;border-radius:50%}.event.deadline:before{background:#c17a32}.event-top{display:flex;justify-content:space-between;gap:15px}.kind{font-size:12px;background:#efebfb;color:#6551ae;border-radius:5px;padding:2px 8px}.deadline .kind{background:#fff0df;color:#9b5b20}.time{font-size:14px;font-weight:600}.event h2{font-size:18px;margin:10px 0}.event p{font-size:14px;margin:8px 0;white-space:pre-wrap;overflow-wrap:anywhere}.location{color:#665e74}.reference{border-top:1px solid #eeebf4;margin-top:15px;padding-top:12px;display:flex;flex-wrap:wrap;gap:4px 18px;font-size:12px;color:#787083;overflow-wrap:anywhere}.reference a{color:#6350ae}details{font-size:12px;margin-top:12px;color:#766b84}summary{cursor:pointer}details p{font-size:13px!important}.uncertain,.empty{background:#fff;border:1px dashed #d9d0e8;padding:24px;border-radius:14px}.uncertain{margin:32px 0 0 153px}.uncertain h2{font-size:18px;margin:0}.uncertain h2 small{font-size:12px;color:#867b93}.uncertain p{font-size:13px;color:#766d81;margin:8px 0}.uncertain article{border-top:1px solid #eee9f4;margin-top:14px;padding-top:14px}.uncertain article span{font-size:12px;color:#81768d;overflow-wrap:anywhere}footer{font-size:12px;color:#81778c;margin-top:30px;text-align:center}@media(max-width:650px){main{padding:24px 18px}.day{grid-template-columns:1fr;gap:8px}.date strong{font-size:20px}.items{margin-left:8px}.uncertain{margin-left:0}.event{padding:16px}h1{font-size:25px}}@media print{body{background:white}main{padding:10px}.event{break-inside:avoid}details p{display:block}}
</style></head><body><main><header><div class="brand">知会 · 事件安排</div><h1>${escape(title)}</h1><p>${from} — ${to} · 北京时间（Asia/Shanghai）</p><div class="summary"><span><strong>${events.length}</strong> 个时间事项</span><span><strong>${groups.size}</strong> 个日期</span><span><strong>${data.undated.length}</strong> 条时间待确认</span></div><p class="coverage">${escape(coverage)}</p></header>${days || '<div class="empty">本次已核对的资料中，没有该范围内时间明确的安排。</div>'}${uncertain}<footer>本地静态快照 · 以事件原文和用户已保存记录为准 · 不代表已报名或已设置提醒</footer></main></body></html>`;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const [input, output] = process.argv.slice(2);
    if (!input || !output) throw new Error('用法：node render-timeline.mjs 输入.json 输出.html');
    const document = renderTimeline(JSON.parse(readFileSync(resolve(input), 'utf8')));
    writeFileSync(resolve(output), document, 'utf8');
    console.log(`已生成时间轴：${resolve(output)}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
