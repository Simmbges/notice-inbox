import panel from "./panel.html?raw";
import { chatGPTSignInPath } from "./chatgpt-auth";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  if (!request.headers.get("oai-authenticated-user-id")) return Response.redirect(new URL(chatGPTSignInPath("/"), request.url));
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#6156d9"><title>知会 · 校园事件整理</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/schedule.css"><link rel="stylesheet" href="/planner.css"><link rel="stylesheet" href="/event-editor.css"><script src="/event-rules.js" defer></script><script src="/schedule.js" defer></script><script src="/event-editor.js" defer></script><script src="/planner.js" defer></script><script src="/app.js" defer></script></head><body>${panel}</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store" } });
}
