import { env } from "cloudflare:workers";
import { categories, checkOrigin, errorResponse, InputError, json, readJSON, requireOwner, recurrenceSchema } from "../../lib/notice-input.ts";
import { importNotices, listNotices } from "../../lib/notice-store.ts";

export const dynamic = "force-dynamic";
const noticeSchema = {
  type: "object", additionalProperties: false, required: ["title"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    content: { type: "string", maxLength: 20000, description: "事件原文，可空；提供原文时保留原始要求，不要用摘要替代。" },
    summary: { type: "string", maxLength: 240 }, category: { type: "string", enum: categories },
    sourceName: { type: "string", maxLength: 80 }, sourceUrl: { type: "string", maxLength: 2000 },
    publishedAt: { type: "string", description: "YYYY-MM-DD，无法确定时留空。" },
    deadline: { type: "string", description: "YYYY-MM-DD，无法确定或未注明时留空，不猜测。" },
    audience: { type: "string", maxLength: 120 }, location: { type: "string", maxLength: 120 },
    recordType: { type: "string", enum: ["schedule", "course"] }, participation: { type: "string", enum: ["reference", "planned"], default: "reference" }, active: { type: "boolean", default: true },
    events: { type: "array", maxItems: 50, items: { type: "object", additionalProperties: false, required: ["title", "date"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, date: { type: "string" }, time: { type: "string" }, endDate: { type: "string" }, endTime: { type: "string" }, kind: { type: "string", enum: ["event", "deadline"] }, evidence: { type: "string", maxLength: 500 }, recurrence: recurrenceSchema } } },
  },
};
const tools = [
  { name: "import_notices", title: "导入校园事件", description: "将用户提供的事件直接保存到知会面板。请从原文提取字段，不虚构日期或要求。相同标题、原文和来源链接会跳过，不覆盖用户修改。返回已保存的事件编号后才表示导入成功。", inputSchema: { type: "object", required: ["notices"], additionalProperties: false, properties: { notices: { type: "array", minItems: 1, maxItems: 50, items: noticeSchema } } }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false } },
  { name: "list_notices", title: "查看已导入的事件", description: "查询当前授权用户的事件，确认是否已保存。", inputSchema: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 50 } } }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
];

export async function POST(request: Request) {
  let id: string | number | null = null;
  try {
    checkOrigin(request);
    const rpc = await readJSON(request);
    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") return json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } }, 400);
    id = rpc.id ?? null;
    if (!Object.hasOwn(rpc, "id")) return new Response(null, { status: 202 });
    const reply = (result: unknown) => json({ jsonrpc: "2.0", id, result });
    if (rpc.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "campus-notice-inbox", version: "1.0.0" }, instructions: "收到用户要求整理或导入校园事件时，提取信息并调用 import_notices。不要仅返回 JSON。保留原文，缺失日期留空。根据工具返回结果告知保存编号或重复提示，不要虚构成功。" });
    if (rpc.method === "ping") return reply({});
    if (rpc.method === "tools/list") return reply({ tools });
    if (rpc.method !== "tools/call") return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    // 平台 OAuth 注入的用户身份决定数据归属，参数不能指定其他用户。
    const owner = requireOwner(request.headers);
    const { name, arguments: args = {} } = rpc.params ?? {};
    let result: unknown;
    try {
      if (name === "import_notices") result = await importNotices(env.DB!, owner, args.notices, "agent");
      else if (name === "list_notices") {
        if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200) || args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw new InputError("query 最长 200 字，limit 范围为 1 至 50。");
        const all = await listNotices(env.DB!, owner);
        const query = (args.query ?? "").toLowerCase();
        const matches = all.filter(n => [n.title, n.content, n.sourceName].join(" ").toLowerCase().includes(query));
        result = { notices: matches.slice(0, args.limit ?? 20), total: matches.length };
      } else return json({ jsonrpc: "2.0", id, error: { code: -32602, message: "Unknown tool" } });
      return reply({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, isError: false });
    } catch (error) {
      if (!(error instanceof InputError)) console.error("notice_mcp_error", error);
      return reply({ content: [{ type: "text", text: error instanceof InputError ? error.message : "服务暂时不可用，请稍后重试。" }], isError: true });
    }
  } catch (error) { return errorResponse(error); }
}

// 无服务端会话和 SSE 流；客户端通过独立 POST 请求调用。
export function GET() { return new Response(null, { status: 405, headers: { Allow: "POST" } }); }
