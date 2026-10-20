import "../public/event-rules.js";

export const categories = ["课程学习", "校园活动", "竞赛报名", "校园事务", "其他通知"];
export const fieldLimits: Record<string, number> = {
  title: 120, content: 20000, summary: 240, sourceName: 80,
  sourceUrl: 2000, audience: 120, location: 120,
};
export const recurrenceSchema = { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['until', 'weekdays'], properties: { until: { type: 'string', description: '周期结束日期 YYYY-MM-DD。' }, weekdays: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'integer', minimum: 1, maximum: 7 } }, intervalWeeks: { type: 'integer', minimum: 1, maximum: 52 }, weeks: { type: 'array', maxItems: 60, items: { type: 'integer', minimum: 1, maximum: 60 } }, excludeDates: { type: 'array', maxItems: 1831, items: { type: 'string' } } } }] };

export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export type NoticeEvent = {
  title: string; date: string; time: string; endDate: string; endTime: string;
  kind: "event" | "deadline"; evidence: string;
  recurrence?: { until: string; weekdays: number[]; intervalWeeks: number; weeks: number[]; excludeDates: string[] } | null;
};

const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function normalizeEvents(value: unknown): NoticeEvent[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new InputError("events 必须是最多 50 项的安排数组。");
  return value.map((item, index) => {
    const label = `第 ${index + 1} 项安排`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new InputError(`${label}必须是一个对象。`);
    const raw = item as Record<string, unknown>;
    const keys = ["title", "date", "time", "endDate", "endTime", "kind", "evidence", "recurrence"];
    try {
      const rules = (globalThis as unknown as { ZhihuiEventRules: { normalizeEvent(raw: unknown): NoticeEvent } }).ZhihuiEventRules;
      const normalized = rules.normalizeEvent(Object.fromEntries(keys.filter(key => raw[key] !== undefined).map(key => [key, raw[key]])));
      const event = Object.fromEntries(keys.filter(key => key !== "recurrence").map(key => [key, normalized[key as keyof NoticeEvent]])) as NoticeEvent;
      if (raw.recurrence !== undefined) event.recurrence = normalized.recurrence;
      return event;
    } catch (error) { throw new InputError(`${label}：${error instanceof Error ? error.message : "格式不正确。"}`); }
  });
}

export type Notice = {
  id: string; title: string; content: string; summary: string; category: string;
  sourceName: string; sourceUrl: string; publishedAt: string; deadline: string;
  audience: string; location: string; createdAt: number; read: boolean;
  favorite: boolean; isDemo: boolean; importedBy: string; events: NoticeEvent[];
  recordType: "schedule" | "course"; participation: "reference" | "planned"; active: boolean;
  updatedAt?: number;
};

export function noticeDefaults<T extends object>(value: T) {
  return { recordType: "schedule" as const, participation: "reference" as const, active: true, ...value };
}

export function normalizeNotice(value: unknown, importedBy = "manual", allowedCategories = categories): Notice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("事件必须是一个对象。");
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(fieldLimits)) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new InputError(`${key} 必须是文本。`);
    const text = ((raw[key] as string) || "").trim();
    if (text.length > limit) throw new InputError(`${key} 最多 ${limit} 个字符。`);
    result[key] = text;
  }
  if (!result.title) throw new InputError("每条事件都需要标题。");
  if (raw.recordType !== undefined && raw.recordType !== "schedule" && raw.recordType !== "course") throw new InputError("recordType 只支持 schedule（事件）或 course（课程）。");
  if (raw.participation !== undefined && raw.participation !== "reference" && raw.participation !== "planned") throw new InputError("participation 只支持 reference（参考信息）或 planned（已安排）。");
  if (raw.active !== undefined && typeof raw.active !== "boolean") throw new InputError("active 必须为布尔值。");
  for (const key of ["publishedAt", "deadline"]) {
    const date = raw[key] ?? "";
    if (typeof date !== "string" || date && !validDate(date)) {
      throw new InputError(`${key} 必须是有效的 YYYY-MM-DD 日期；不确定时留空。`);
    }
    result[key] = date;
  }
  if (result.sourceUrl) {
    try {
      const url = new URL(result.sourceUrl as string);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      result.sourceUrl = url.href;
    } catch { throw new InputError("原文链接仅支持 HTTP 或 HTTPS。"); }
  }
  if (raw.category !== undefined && !allowedCategories.includes(raw.category as string)) throw new InputError(`请选择已有分类：${allowedCategories.map(name => name === "其他通知" ? "其他事件" : name).join("、")}。可在面板中管理分类。`);
  return {
    ...result, id: typeof raw.id === "string" && raw.id.length <= 160 && raw.id ? raw.id : crypto.randomUUID(),
    category: (raw.category as string) || "其他通知",
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    read: raw.read === true, favorite: raw.favorite === true, isDemo: raw.isDemo === true, importedBy, events: normalizeEvents(raw.events),
    recordType: (raw.recordType as Notice["recordType"]) || "schedule", participation: (raw.participation as Notice["participation"]) || "reference", active: raw.active !== false,
  } as Notice;
}

export function fingerprintText(notice: Notice): string {
  const content = [notice.title, notice.content, notice.sourceUrl].map(s => s.replace(/\s+/g, " ").trim());
  // 有原文时保持历史指纹；仅标题的个人记录使用时间安排区分不同日期。
  const identity = notice.content.trim() ? content : [...content, notice.deadline, notice.events.map(event => [event.title, event.date, event.time, event.endDate, event.endTime, event.kind, event.recurrence || null])];
  return JSON.stringify(identity);
}

export async function fingerprint(notice: Notice): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprintText(notice)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export function requireOwner(headers: Headers): string {
  const owner = headers.get("oai-authenticated-user-id");
  if (!owner) throw new InputError("请先登录并授权 Agent 连接你的事件库。", 401);
  return owner;
}

export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin || request.headers.get("sec-fetch-site") === "cross-site") throw new InputError("不允许跨站写入。", 403);
}

export async function readJSON(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json")) throw new InputError("请使用 application/json。", 415);
  if (Number(request.headers.get("content-length")) > 2 * 1024 * 1024) throw new InputError("请求不得超过 2 MB。", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("请求正文不能为空。");
  const chunks = []; let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2 * 1024 * 1024) { await reader.cancel(); throw new InputError("请求不得超过 2 MB。", 413); }
    chunks.push(value);
  }
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new InputError("请求不是有效的 JSON。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("请求正文必须是 JSON 对象。");
  return value;
}

export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "private, no-store", "Vary": "Cookie, Authorization" } });
export function errorResponse(error: unknown) {
  if (error instanceof InputError) return json({ error: error.message }, error.status);
  console.error("notice_api_error", error);
  return json({ error: "保存服务暂时不可用，请稍后重试。" }, 500);
}
