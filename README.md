# 知会 · 校园通知整理

一个可由 Agent 直接写入的校园通知面板。保留原有轻量前端，使用 Sites Worker、Cloudflare D1 和 MCP 实现自动导入与跨设备保存。

## 使用

访问已发布的网站并登录。通知属于当前授权用户，每 5 秒自动刷新；手动添加、编辑、删除撤销、搜索、分类、收藏、已读和 JSON 备份仍可使用。

Agent 首次连接方式、工具参数和边界见 [AGENT_INTEGRATION.md](./AGENT_INTEGRATION.md)。本站不内置大模型，整理、识图、读链接和语音转写由 Agent 负责。连小理的 MCP 接入能力尚未实测。

旧版通知仍保留在原浏览器的 `campus-notice-inbox.v1` 存储中。页面检测到未迁移的真实通知时会显示迁移入口，迁移不会清除本地原始数据。旧示例不会自动上传。旧版 JSON 备份仍可导入，按编号或通知内容跳过重复，不覆盖已有通知。浏览器地址不同则原有本地存储不可见，需要从旧地址导出备份迁移。

## 本地开发

要求 Node.js >= 22.13.0。

```powershell
npm run install:ci
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_sparkling_frog_thor.sql
npm run dev -- --port 4173 --hostname 127.0.0.1
```

访问 `http://127.0.0.1:4173`。官方 portable 模板仅在本地模拟登录为开发用户；生产环境由 Sites 处理身份认证。SQL 命令仅在新本地数据库执行一次；后续按生成的迁移顺序应用，不要重复执行已经应用的迁移。

Windows 若 npm 启动器错误地将自身安装路径识别为项目目录，可以用 `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"` 替代 `npm` 命令。

## 验证

```powershell
node --test tests/notices.test.ts
node --check public/app.js
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

测试验证真实 SQLite 迁移、原子批次写入、去重、用户隔离、独立修改、日期和请求边界。线上数据库与本地数据库相互独立，不发布本地测试通知。

## 源码

- `public/`：前端脚本和样式；`app/panel.html`：面板结构。
- `app/api/notices/route.ts`：当前用户的通知增删改查。
- `app/mcp/route.ts`：Agent 工具入口。
- `lib/notice-input.ts`、`lib/notice-store.ts`：校验与数据库操作。
- `db/schema.ts`、`drizzle/`：数据库表结构及迁移。

通知原文以纯文本展示，来源链接仅允许 HTTP / HTTPS。服务端按平台用户编号查询和修改数据，不接收客户端指定的数据归属。备份文件包含通知正文，导出后请自行保管。
