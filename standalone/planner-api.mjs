import { createHash } from 'node:crypto';
import { InputError, normalizeEvents, noticeDefaults, fingerprintText, recurrenceSchema } from '../lib/notice-input.ts';
import { createEventStore } from './event-store.mjs';
import { createTaskStore } from './task-store.mjs';

const text = (maxLength = 120) => ({ type: 'string', maxLength });
const day = { type: 'string', description: 'YYYY-MM-DD；未知可留空，必填日期不得为空。' };
const time = { type: 'string', description: 'HH:mm；未知留空，不猜测。' };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
const version = { type: 'integer', minimum: 0, description: '从最新查询结果读取的 version，冲突后重新查询。' };
const range = { from: day, to: day };
const recurrence = recurrenceSchema;
const eventProperties = { title: text(), date: day, time, endDate: day, endTime: time, kind: { type: 'string', enum: ['event', 'deadline'] }, recordType: { type: 'string', enum: ['schedule', 'course'], description: 'schedule 为个人事件（默认），course 为课程；与一次性或周期性独立，导入课表须明确传 course。' }, participation: { type: 'string', enum: ['reference', 'planned'], description: 'reference 为参考信息，planned 为用户已安排；个人日程接口默认 planned，有日期本身不代表参加。' }, location: text(), notes: text(20000), sourceName: text(80), sourceText: text(20000), sourceUrl: text(2000), noticeId: text(160), recurrence, active: { type: 'boolean' }, category: { ...text(30), description: '使用当前账号已有分类；省略时按 recordType 归入日程或课程对应的默认分类，重命名后跟随新名称。' }, favorite: { type: 'boolean' } };
const taskProperties = { title: text(), notes: text(4000), noticeId: text(160), status: { type: 'string', enum: ['todo', 'in_progress', 'done', 'cancelled'] }, priority: { type: 'string', enum: ['high', 'normal', 'low'] }, dueDate: day, estimatedMinutes: { type: 'integer', minimum: 0, maximum: 10080 }, plannedDate: day, plannedStartTime: time, plannedEndTime: time };
const preferenceProperties = { timeZone: { type: 'string', enum: ['Asia/Shanghai'] }, dailyCapacityMinutes: { type: 'integer', minimum: 0, maximum: 1440 }, bufferMinutes: { type: 'integer', minimum: 0, maximum: 180 }, dayStart: time, dayEnd: time, notes: text(2000), semesterStart: day, semesterEnd: day, classPeriods: { type: 'array', maxItems: 30, items: object({ period: { type: 'integer', minimum: 1, maximum: 30 }, start: time, end: time }, ['period', 'start', 'end']) } };
const tool = (name, title, description, inputSchema, permission = 'manage') => ({ name, title, description, inputSchema, annotations: { readOnlyHint: permission === 'read', destructiveHint: false, openWorldHint: false }, permission });
const definitions = [
  tool('list_events', '查询时间表', '查询事件、课程和任务的时间。recordType 选 schedule 或 course 时返回全部来源中对应的事件或课程；all 还包含任务。周期规则按日期展开为每次发生的实例；含起止日，最长366天，分页读取。participation=reference 只是参考信息，不代表用户参加；planned 才是已安排。未整理的原文不在覆盖范围。', object({ ...range, type: { type: 'string', enum: ['all', 'once', 'recurring'] }, recordType: { type: 'string', enum: ['all', 'schedule', 'course'] }, kind: { type: 'string', enum: ['all', 'event', 'deadline'] }, query: text(200), limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0 } }), 'read'),
  tool('import_events', '导入个人日程或课程', '保存一次性或周期事件，最多100项；截图由Agent识别。只有标题必填；日期未知可空，但不能仅填时分或周期规则。课程明确传 recordType=course，个人日程传 schedule（默认），不要依据重复方式猜类型。周期date必须有效，其所在周周一是第1周，until为结束日期，weekdays为周一1至周日7，weeks指定周次。已有重复不覆盖。保留来源转写。', object({ events: { type: 'array', minItems: 1, maxItems: 100, items: object(eventProperties, ['title']) } }, ['events'])),
  tool('update_event', '修改日程规则', '修改个人一次性事件或整个周期系列。需最新version；仅某一天调课或停课用change_event_occurrence，不要修改整个系列。active=false取消，true恢复。', object({ id: text(160), expectedVersion: version, patch: object(eventProperties) }, ['id', 'expectedVersion', 'patch'])),
  tool('change_event_occurrence', '单次调课或停课', '仅修改周期事件指定发生日，后续周不变。changes=null停课；其他changes创建替代一次性事件并排除原发生日。先确认用户所指范围。', object({ id: text(160), expectedVersion: version, occurrenceDate: day, changes: { anyOf: [{ type: 'null' }, object({ date: day, time, endTime: time, location: text(), title: text() })] } }, ['id', 'expectedVersion', 'occurrenceDate', 'changes'])),
  tool('update_notice_events', '修改事件的时间安排', '只替换事件记录的events，保留原文和其他字段；每个时间点可有独立recurrence。先get_notice读取当前events及updatedAt，合并用户明确修改后提交完整数组。', object({ id: text(160), expectedUpdatedAt: { type: 'integer', minimum: 0 }, events: { type: 'array', maxItems: 50, items: object({ title: text(), date: day, time, endDate: day, endTime: time, kind: { type: 'string', enum: ['event', 'deadline'] }, evidence: text(500), recurrence }, ['title', 'date']) } }, ['id', 'expectedUpdatedAt', 'events'])),
  tool('list_tasks', '查询个人任务', '实时读取任务及完成、计划、预计用时；不把原文事件记录或收藏当个人承诺。', object({ status: { type: 'string', enum: ['all', 'todo', 'in_progress', 'done', 'cancelled'] }, query: text(200) }), 'read'),
  tool('create_task', '保存个人任务', '按用户明确目标创建个人任务，可关联原文事件；估时是建议而非实际用时。相同活跃标题与原文事件关联会复用，不覆盖已有任务。', object({ task: object(taskProperties, ['title']) }, ['task'])),
  tool('update_task', '更新任务与计划', '根据用户反馈标记进行中、完成、重开、取消或调整执行时段。需最新version；取消可恢复。', object({ id: text(160), expectedVersion: version, patch: object(taskProperties) }, ['id', 'expectedVersion', 'patch'])),
  tool('get_preferences', '读取时间偏好与课表设置', '读取用户持久偏好、学期日期和节次作息映射。未保存的数据不能猜测。', object({}), 'read'),
  tool('update_preferences', '保存时间偏好与学期设置', '保存用户明确的可用时长、缓冲、作息、学期第1周日期和节次时间。使用最新version，首次为0。', object({ patch: object(preferenceProperties), expectedVersion: version }, ['patch', 'expectedVersion'])),
  tool('review_period', '查看计划执行复盘', '按日期查看真实完成记录、计划、到期、逾期和任务修改历史。估时不能当作实际学习时长；计划不代表完成。最长366天。', object(range, ['from', 'to']), 'read'),
];

export function createPlanner(sqlite) {
  const events = createEventStore(sqlite), tasks = createTaskStore(sqlite);
  const tools = permission => definitions.filter(tool => permission === 'manage' || tool.permission === 'read' && ['read', 'read_import'].includes(permission)).map(definition => { const tool = { ...definition }; delete tool.permission; return tool; });
  function call(owner, name, args = {}) {
    const definition = definitions.find(tool => tool.name === name);
    if (!definition || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(definition.inputSchema.properties, key)) || definition.inputSchema.required.some(key => !Object.hasOwn(args, key))) throw new InputError('工具参数不正确，请使用当前工具声明的字段。');
    if (name === 'list_events') return events.occurrences(owner, args);
    if (name === 'import_events') return events.import(owner, args.events);
    if (name === 'update_event') return { event: events.update(owner, args.id, args.patch, args.expectedVersion) };
    if (name === 'change_event_occurrence') return events.changeOccurrence(owner, args.id, args.expectedVersion, args.occurrenceDate, args.changes);
    if (name === 'list_tasks') return tasks.list(owner, args);
    if (name === 'create_task') return tasks.create(owner, args.task);
    if (name === 'update_task') return tasks.update(owner, args.id, args.patch, args.expectedVersion);
    if (name === 'get_preferences') return tasks.settings(owner);
    if (name === 'update_preferences') return tasks.saveSettings(owner, args.patch, args.expectedVersion);
    if (name === 'review_period') return tasks.review(owner, args);
    if (typeof args.id !== 'string' || !args.id || !Number.isSafeInteger(args.expectedUpdatedAt)) throw new InputError('请提供事件编号和最新 updatedAt。');
    const row = sqlite.prepare('SELECT data, updated_at FROM notices WHERE owner_id = ? AND id = ?').get(owner, args.id);
    if (!row) throw new InputError('事件不存在或不属于当前账号。', 404);
    if (row.updated_at !== args.expectedUpdatedAt) throw new InputError('事件已变化，请重新读取后再修改。', 409);
    const notice = noticeDefaults({ ...JSON.parse(row.data), events: normalizeEvents(args.events) }), updatedAt = Math.max(Date.now(), row.updated_at + 1);
    const hash = createHash('sha256').update(fingerprintText(notice)).digest('hex');
    if (sqlite.prepare('SELECT id FROM notices WHERE owner_id = ? AND fingerprint = ? AND id != ?').get(owner, hash, args.id)) throw new InputError('事件库中已有相同事件。', 409);
    sqlite.prepare('UPDATE notices SET data = ?, fingerprint = ?, updated_at = ? WHERE owner_id = ? AND id = ?').run(JSON.stringify(notice), hash, updatedAt, owner, args.id);
    return { notice, updatedAt };
  }
  return { events, tasks, tools, call };
}
