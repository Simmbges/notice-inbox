import panel from "./panel.html?raw";
import { chatGPTSignInPath } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (!request.headers.get("oai-authenticated-user-id")) return Response.redirect(new URL(chatGPTSignInPath("/"), request.url));
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#6156d9"><title>知会 · 校园通知整理</title><link rel="stylesheet" href="/styles.css"><script src="/app.js" defer></script></head><body>${panel}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
}
