import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InputError, errorResponse, json, readJSON } from '../lib/notice-input.ts';
import { deleteNotices, importNotices, listNotices, updateNotice } from '../lib/notice-store.ts';
import { openDatabase } from './database.mjs';
import { createAuth } from './auth.mjs';
import { agentImport, handleMcp } from './mcp.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(resolve(root, path), 'utf8');
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
};
const html = text => new Response(text, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const redirect = path => new Response(null, { status: 303, headers: { Location: path } });

export function createApplication({ databaseFile, origin, trustProxy = false, cookieSuffix = '' }) {
  const expected = new URL(origin);
  if (!['http:', 'https:'].includes(expected.protocol) || expected.origin !== origin) throw new Error('APP_URL 必须是完整站点地址，末尾不带斜杠。');
  const secure = expected.protocol === 'https:';
  const database = openDatabase(databaseFile);
  const { sqlite, db } = database;
  const auth = createAuth(sqlite, secure, cookieSuffix);
  const panel = read('app/panel.html')
    .replace('通知保存在云端', '通知保存在部署机器')
    .replace('Agent 导入 · 云端保存', 'Agent 导入 · 服务端保存')
    .replace('<main class="workspace">', '<main class="workspace"><div class="account-bar"><span id="account-email">正在读取账号…</span><button id="logout-account" class="text-button">退出登录</button></div>');
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#6156d9"><title>知会 · 校园通知整理</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/account.css"><script src="/app.js" defer></script><script src="/account.js" defer></script></head><body data-auth="email">${panel}${read('standalone/public/key-dialog.html')}</body></html>`;
  const staticFiles = new Map([
    ['/app.js', ['public/app.js', 'text/javascript']], ['/styles.css', ['public/styles.css', 'text/css']],
    ['/login.js', ['standalone/public/login.js', 'text/javascript']], ['/account.js', ['standalone/public/account.js', 'text/javascript']],
    ['/account.css', ['standalone/public/account.css', 'text/css']],
  ].map(([path, [file, type]]) => [path, { text: read(file), type }]));

  function checkWriteOrigin(request) {
    const supplied = request.headers.get('origin');
    if (supplied && supplied !== origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new InputError('不允许跨站写入。', 403);
  }
  const bodyJSON = async (request, limit = 2 * 1024 * 1024) => {
    if (Number(request.headers.get('content-length')) > limit) throw new InputError('请求正文过大。', 413);
    return readJSON(request);
  };

  async function route(request, ip) {
    const { pathname } = new URL(request.url), method = request.method;
    if (method === 'GET' && staticFiles.has(pathname)) {
      const file = staticFiles.get(pathname);
      return new Response(file.text, { headers: { 'Content-Type': `${file.type}; charset=utf-8` } });
    }
    if (method === 'GET' && pathname === '/healthz') { sqlite.prepare('SELECT 1').get(); return json({ ok: true }); }
    if (method === 'GET' && pathname === '/login') {
      try { auth.user(request.headers); return redirect('/'); }
      catch (error) { if (!(error instanceof InputError)) throw error; }
      return html(read('standalone/public/login.html'));
    }
    if (method === 'GET' && pathname === '/') {
      try { auth.user(request.headers); return html(page); }
      catch (error) { if (error instanceof InputError) return redirect('/login'); throw error; }
    }
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return json({ error: '不支持该请求方法。' }, 405);
    if (method !== 'GET') checkWriteOrigin(request);

    if (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(pathname)) {
      const body = await bodyJSON(request, 16384);
      const action = pathname.endsWith('/register') ? auth.register : auth.login;
      const result = await action(body, ip, request.headers);
      const response = json({ user: result.user }); response.headers.set('Set-Cookie', result.cookie); return response;
    }
    if (method === 'POST' && pathname === '/api/auth/logout') {
      const response = json({ ok: true }); response.headers.set('Set-Cookie', auth.logout(request.headers)); return response;
    }
    if (pathname === '/api/agent/notices' && method === 'POST') {
      const owner = auth.agent(request.headers);
      return json(await agentImport(db, owner, (await bodyJSON(request)).notices));
    }
    if (pathname === '/mcp') return method === 'POST' ? handleMcp(request, auth, db) : json({ error: 'MCP 入口仅支持 POST。' }, 405);

    if (pathname === '/api/account') {
      if (method !== 'GET') return json({ error: '不支持该请求方法。' }, 405);
      return json({ user: auth.user(request.headers) });
    }
    if (pathname === '/api/agent-keys' || /^\/api\/agent-keys\/[^/]+$/.test(pathname)) {
      const owner = auth.user(request.headers).id;
      if (pathname === '/api/agent-keys' && method === 'GET') return json({ keys: auth.keys(owner) });
      if (pathname === '/api/agent-keys' && method === 'POST') return json(auth.createKey(owner, (await bodyJSON(request, 16384)).name));
      if (method === 'DELETE' && pathname !== '/api/agent-keys') { auth.revokeKey(owner, pathname.split('/').pop()); return json({ ok: true }); }
      return json({ error: '不支持该请求方法。' }, 405);
    }
    if (pathname === '/api/notices') {
      const owner = auth.user(request.headers).id;
      if (method === 'GET') return json({ notices: await listNotices(db, owner) });
      const body = await bodyJSON(request);
      if (method === 'POST') return json(await importNotices(db, owner, body.notices, 'manual'));
      if (method === 'PATCH') return json({ notice: await updateNotice(db, owner, body.id, body.patch) });
      await deleteNotices(db, owner, body.ids); return json({ ok: true });
    }
    return json({ error: '页面不存在。' }, 404);
  }

  const handler = async (incoming, outgoing) => {
    let response;
    try {
      if (incoming.headers.host !== expected.host) throw new InputError('站点地址不匹配，请使用配置的访问地址。', 400);
      let ip = incoming.socket.remoteAddress || 'unknown';
      if (trustProxy && incoming.headers['x-forwarded-for']) ip = String(incoming.headers['x-forwarded-for']).split(',').pop().trim();
      const hasBody = !['GET', 'HEAD'].includes(incoming.method);
      const request = new Request(new URL(incoming.url, origin), { method: incoming.method, headers: incoming.headers, ...(hasBody ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) });
      response = await route(request, ip);
    } catch (error) { response = errorResponse(error); }
    if (secure) outgoing.setHeader('Strict-Transport-Security', 'max-age=31536000');
    for (const [key, value] of Object.entries(securityHeaders)) outgoing.setHeader(key, value);
    for (const [key, value] of response.headers) outgoing.setHeader(key, value);
    outgoing.statusCode = response.status;
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  };
  return { handler, database };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
  const origin = process.env.APP_URL || `http://127.0.0.1:${port}`;
  if (process.env.NODE_ENV === 'production' && !origin.startsWith('https://')) throw new Error('生产部署需要配置 HTTPS 的 APP_URL。');
  const app = createApplication({ databaseFile: resolve(process.env.DATA_DIR || resolve(root, 'data'), 'notice-inbox.sqlite'), origin, trustProxy: process.env.TRUST_PROXY === 'true' });
  const server = createServer(app.handler);
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  server.listen(port, process.env.HOST || '127.0.0.1', () => console.log(`知会独立版已启动：${origin}\n邮箱登录 · 数据保存在部署机器 · Agent 密钥导入`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => { app.database.close(); process.exit(0); }));
}
