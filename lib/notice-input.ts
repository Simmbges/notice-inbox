export const categories = ["课程学习", "校园活动", "竞赛报名", "校园事务", "其他通知"];
export const fieldLimits: Record<string, number> = {
  title: 120, content: 20000, summary: 240, sourceName: 80,
  sourceUrl: 2000, audience: 120, location: 120,
};

export class InputError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export type Notice = {
  id: string; title: string; content: string; summary: string; category: string;
  sourceName: string; sourceUrl: string; publishedAt: string; deadline: string;
  audience: string; location: string; createdAt: number; read: boolean;
  favorite: boolean; isDemo: boolean; importedBy: string;
};

export function normalizeNotice(value: unknown, importedBy = "manual", allowedCategories = categories): Notice {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("通知必须是一个对象。");
  const raw = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, limit] of Object.entries(fieldLimits)) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw new InputError(`${key} 必须是文本。`);
    const text = ((raw[key] as string) || "").trim();
    if (text.length > limit) throw new InputError(`${key} 最多 ${limit} 个字符。`);
    result[key] = text;
  }
  if (!result.title || !result.content) throw new InputError("每条通知都需要标题和原文正文。");
  for (const key of ["publishedAt", "deadline"]) {
    const date = raw[key] ?? "";
    if (typeof date !== "string" || date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
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
  if (raw.category !== undefined && !allowedCategories.includes(raw.category as string)) throw new InputError(`请选择已有分类：${allowedCategories.join("、")}。可在面板中管理分类。`);
  return {
    ...result, id: typeof raw.id === "string" && raw.id.length <= 160 && raw.id ? raw.id : crypto.randomUUID(),
    category: (raw.category as string) || "其他通知",
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    read: raw.read === true, favorite: raw.favorite === true, isDemo: raw.isDemo === true, importedBy,
  } as Notice;
}

export async function fingerprint(notice: Notice): Promise<string> {
  const content = [notice.title, notice.content, notice.sourceUrl].map(s => s.replace(/\s+/g, " ").trim());
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(content)));
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
}

export function requireOwner(headers: Headers): string {
  const owner = headers.get("oai-authenticated-user-id");
  if (!owner) throw new InputError("请先登录并授权 Agent 连接你的通知库。", 401);
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
