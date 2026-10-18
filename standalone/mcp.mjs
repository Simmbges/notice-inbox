import { categories, fieldLimits, InputError, json, readJSON } from '../lib/notice-input.ts';
import { importNotices } from '../lib/notice-store.ts';

const tool = {
  name: 'import_notices', title: '导入校园通知',
  description: '将用户提供的通知保存到知会。保留原文，缺失日期留空。返回通知编号才代表保存成功，重复内容不会覆盖。此密钥仅允许导入。',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['notices'],
    properties: { notices: { type: 'array', minItems: 1, maxItems: 50, items: {
      type: 'object', additionalProperties: false, required: ['title', 'content'],
      properties: {
        ...Object.fromEntries(Object.entries(fieldLimits).map(([key, maxLength]) => [key, { type: 'string', maxLength }])),
        category: { type: 'string', enum: categories },
        publishedAt: { type: 'string', description: 'YYYY-MM-DD，无法确定时留空。' },
        deadline: { type: 'string', description: 'YYYY-MM-DD，无法确定时留空，不猜测。' },
      },
    } } },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export async function agentImport(db, owner, notices) {
  const allowed = new Set([...Object.keys(fieldLimits), 'category', 'publishedAt', 'deadline']);
  const values = Array.isArray(notices) ? notices.map(value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key))) : value) : notices;
  const result = await importNotices(db, owner, values, 'agent');
  return { ...result, created: result.created.map(n => ({ id: n.id, title: n.title })) };
}

export async function handleMcp(request, auth, db) {
  const rpc = await readJSON(request);
  const id = rpc.id ?? null;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return json({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } }, 400);
  // 调用方配置自己的 Bearer 密钥，无需 OpenAI 登录。
  const owner = auth.agent(request.headers);
  if (!Object.hasOwn(rpc, 'id')) return new Response(null, { status: 202 });
  const reply = result => json({ jsonrpc: '2.0', id, result });
  if (rpc.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'campus-notice-inbox', version: '2.0.0' }, instructions: '用户要求整理并导入通知时调用 import_notices，不要只生成 JSON。保留原文，日期不确定就留空，以工具返回的编号为保存凭证。' });
  if (rpc.method === 'ping') return reply({});
  if (rpc.method === 'tools/list') return reply({ tools: [tool] });
  if (rpc.method !== 'tools/call') return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  if (rpc.params?.name !== 'import_notices') return json({ jsonrpc: '2.0', id, error: { code: -32602, message: '此密钥只支持 import_notices' } });
  try {
    const result = await agentImport(db, owner, rpc.params.arguments?.notices);
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    return reply({ content: [{ type: 'text', text: error.message }], isError: true });
  }
}
