import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "知会 · 校园通知整理",
  description: "让 Agent 整理校园通知，自动保存到你的通知库。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <head><link rel="stylesheet" href="/styles.css" /></head>
      <body>{children}<script src="/app.js" defer /></body>
    </html>
  );
}
