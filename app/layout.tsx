import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "知会 · 校园事件整理",
  description: "让 Agent 整理校园事件，自动保存到你的事件库。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head><link rel="stylesheet" href="/styles.css" /><link rel="stylesheet" href="/schedule.css" /><link rel="stylesheet" href="/planner.css" /><link rel="stylesheet" href="/event-editor.css" /></head>
      <body>{children}<script src="/event-rules.js" defer /><script src="/schedule.js" defer /><script src="/event-editor.js" defer /><script src="/planner.js" defer /><script src="/app.js" defer /></body>
    </html>
  );
}
