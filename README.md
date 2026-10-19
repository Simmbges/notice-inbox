# 知会 · 校园通知整理

一个可由 Agent 查询和写入的校园通知面板，用于集中保存、整理和查看分散的校园通知。当前版本使用邮箱＋密码登录、SQLite 持久化保存、每人独立且可撤销的 Agent 密钥，不依赖 OpenAI 账号。

使用流程：把通知发给 Agent → Agent 提取标题、摘要、分类和日期并保留原文 → 调用工具入库 → 网页面板自动显示。

已连接 MCP 的电脑端 Agent 还可使用随项目提供的 `zhihui-notices` skill，实时查询通知、读取原文，并把近期安排生成本地 HTML 时间轴。当前优先完善电脑端使用，手机与机器人通道暂缓。

## 当前进度（2026-10-18）

项目已达到本地可用、可演示完整流程、具备独立部署配置的阶段，尚未部署到独立公网服务器。

| 模块 | 已完成内容 |
|---|---|
| 通知面板 | 添加、编辑、删除及撤销、搜索、自定义分类、收藏、已读、截止日期筛选和排序；桌面阅读布局、原文滚动、来源标记及连接弹窗优化 |
| 数据保存 | SQLite 持久化、账号数据隔离、JSON 备份导入导出和重复通知跳过 |
| 独立账号 | 邮箱＋密码注册、登录、退出，不依赖 OpenAI 登录 |
| Agent 接入 | MCP 和 HTTP 查询、导入、原文读取；密钥可选仅导入、仅查询或查询＋导入，90 天有效并可撤销 |
| Agent skill | 可复用的 `zhihui-notices` skill，包含写入、查询、原文核对、日期语义和时间轴工作流；面板可直接下载 |
| 日程可视化 | 零依赖 Node.js 本地 HTML 时间轴，区分活动与截止，附通知编号、日期证据和待确认事项 |
| Codex 验证 | 已完成本地 MCP 工具发现和使用配置凭据导入测试通知；开发环境的 Codex 已加载导入工具 |
| 连小理验证 | 用户已完成导入测试，确认可向通知面板写入信息 |
| 本地启动包 | Windows x64 自带运行环境、双击启动和停止、自动打开浏览器、端口避让和重复启动保护 |
| 部署准备 | 独立部署包、Docker Compose、Caddy HTTPS 配置和部署文档 |

尚未完成：

- 独立公网部署、Docker 容器构建和公网 HTTPS 验证。
- 真实校园通知的整理准确率、日期提取与去重效果评测。
- 邮箱验证和邮件找回密码。
- skill 在连小理等具体客户端安装后的实际调用体验；当前已验证 MCP 到时间轴的程序集成，手机通道暂缓。

## 快速开始：Windows 本地启动包

适用于 Windows 10 / 11 x64，无需安装 Node.js、npm 或 Docker，也无需云端账号。

1. 完整解压 `releases/zhihui-windows-x64.zip`，不要在压缩包内直接运行。
2. 打开“知会本地版”文件夹，双击“启动知会.cmd”，程序会自动打开浏览器。
3. 首次使用注册邮箱账号。使用期间保留启动窗口，停止时双击“停止知会.cmd”，或在启动窗口按 Ctrl+C。

默认使用 `http://127.0.0.1:4173`；端口被占用时自动选择可用端口，并记住本次地址。重复双击会重新打开已经运行的面板，不会再启动一个服务。实际网页和 MCP 地址以启动窗口、面板显示为准。

启动包的账号和通知保存在包内的 `data` 文件夹。它与源码运行目录的数据相互独立，压缩包不包含开发者的账号、通知或密钥。旧通知可通过 JSON 备份导入；账号和 Agent 密钥需要重新创建，原有 Codex 连接不会自动切换。完整备份或搬家前先停止程序，再复制整个 `data` 文件夹。

维护者可在 PowerShell 7 中构建启动包（使用启动包不需要 PowerShell 7）：

```powershell
pwsh -NoProfile -File standalone/build-portable.ps1
```

首次构建会从 Node.js 官方下载固定版本的 Windows x64 运行环境并核对 SHA256，包含运行环境的开源许可；产物为 `releases/zhihui-windows-x64.zip` 和同名 `.sha256` 校验文件。解压后的程序运行不需要联网下载依赖。

启动包测试（先构建，测试只在 Windows 且存在压缩包时运行）：

```powershell
node --test standalone/portable.test.mjs
```

测试会从实际压缩包解压，在带中文和空格的路径运行 CMD 入口，验证端口避让、重复启动、注册、MCP 导入、停止与重启后数据保留，使用临时目录。

## 从源码运行：独立邮箱版

需要 Node.js 24。在项目根目录运行，无需安装 npm 依赖或执行前端构建：

```powershell
node standalone/server.mjs
```

打开 [本地登录页](http://127.0.0.1:4173/login)，注册自己的邮箱账号，密码为 12—128 个字符。没有默认账号；目前邮箱只作为登录名，不发送验证邮件。

也可以在 Windows 右键 `standalone/start.ps1`，选择“使用 PowerShell 运行”。关闭运行程序的终端会停止服务，再次启动后原有账号和通知仍保留。

默认本地地址仅供这台电脑直接访问。工具若在其他机器执行，则需要本机执行桥或可访问的服务地址。

## 自定义通知分类

在侧边栏“通知分类”右侧点击“管理”，可新增、重命名和删除分类，按账号保存，重启后保留。每个名称为 1—30 个字符，最多 30 个分类；初始五类也可调整。“其他通知”作为保留分类，不能重命名或删除。

重命名会同步更新已有通知；删除分类会将其中的通知移到“其他通知”，保留通知原文、编号、收藏和已读状态。通知表单和筛选栏同步使用当前分类，JSON 备份会带上分类（包括空分类），导入时恢复缺少的分类。

MCP 导入和查询也支持当前账号的分类；当前工具 schema 和查询结果的 `categories` 会给出可用名称。分类管理通过网页登录会话操作，Agent 密钥不能管理分类；未创建的分类会返回错误，需要先在面板添加。Agent 客户端若缓存了旧分类枚举，请刷新 MCP 工具列表。

## 连接 Agent

1. 登录面板，点击“连接 Agent”，选择“仅导入”“仅查询”或“查询＋导入”，创建并复制密钥。完整密钥只显示一次。
2. 在支持外部工具的 Agent 中配置以下任一入口，认证头为 `Authorization: Bearer 你的密钥`。
3. 把通知发给 Agent 要求保存，或提问“未来七天有哪些通知截止？”“把这条通知的原文发给我”。

| 接入方式 | 本地地址 | 用途 |
|---|---|---|
| MCP（Streamable HTTP） | `http://127.0.0.1:4173/mcp` | 按授权提供 `import_notices`、`list_notices`、`get_notice` |
| HTTP | `http://127.0.0.1:4173/api/agent/notices` | POST 导入，GET 查询，GET `/api/agent/notices/通知编号` 读取原文 |

部署后将地址替换为自己的 HTTPS 域名。远程 Agent 的 `127.0.0.1` 指向它自己的运行环境，不能用这个地址连接你的电脑。

旧密钥保持仅导入权限；查询需要新建“仅查询”或“查询＋导入”密钥。所有密钥均不能修改、删除通知，有效期 90 天，可在面板撤销。其他使用者仍需配置自己的地址和密钥；客户端如果有工具白名单，也需按新密钥的权限更新。不要把真实密钥写进源码、URL 或通知正文。

面板每 5 秒检查新通知，回到页面时也会刷新。只有工具返回成功结果和保存编号，才代表通知已保存。参数、示例与权限边界见 [Agent 接入说明](./AGENT_INTEGRATION.md)。

本站不内置大模型、OCR、网页抓取或语音识别。整理、截图识别、链接读取和语音转写由调用方 Agent 负责。连小理接入与通知导入已由用户实测通过。

### 让 Agent 自动配置 MCP 的提示词

适用于能够读写本机客户端配置的 Agent。先启动知会，在面板点击“连接 Agent”，按需选择权限并复制 MCP 地址和密钥，再替换下方占位内容；也可在创建密钥后直接点击“复制配置提示词”。既要查通知也要保存时选择“查询＋导入”。启动包可能自动更换端口，请使用面板显示的实际地址。真实密钥只填写到发给受信任 Agent 的消息中，不要写回本 README 或公开仓库。

```text
请帮我把本机运行的“知会”配置为当前 Agent 客户端的 MCP 服务，并实际验证可用性。

服务名称：zhihui_local
服务地址：【粘贴面板显示的 MCP 地址】
传输方式：Streamable HTTP
认证方式：Authorization: Bearer 【粘贴所选权限的密钥】
工具按密钥权限开放：仅导入为 import_notices；仅查询为 list_notices、get_notice；查询＋导入为三个工具。

请直接完成配置：
1. 识别当前客户端支持的 MCP 配置方式，保留已有配置，只新增或更新 zhihui_local。
2. 优先使用客户端支持的安全凭据方式保存密钥，不在输出中复述密钥，不写进项目源码或提交到 Git。
3. 检查本地知会是否运行，验证 MCP 初始化和工具发现，按发现结果更新本服务的工具白名单。旧密钥只会发现 import_notices，不要尝试自行提升密钥权限。
4. 有导入权限时，调用 import_notices 导入一条“【MCP连接测试】自动配置验证”通知，正文写明“这是自编连接测试，不是真实校园通知”，分类为“其他通知”，日期留空。有查询权限时，调用 list_notices，再用返回的完整编号调用 get_notice 核对原文；无结果时如实说明。不要仅生成 JSON。
5. 最后告诉我配置位置、连接结果、测试通知保存编号，以及当前会话是否需要重新加载或重启才能使用。

请区分“配置已写入”“连接验证成功”“当前会话已加载工具”，不要把它们当作同一件事。遇到失败请定位原因；缺少信息或确实需要我操作时，再明确说明。
```

### 安装并使用通知 skill

先连接好 MCP，再将 [skills/zhihui-notices](./skills/zhihui-notices/SKILL.md) 文件夹安装到所用 Agent 的技能目录；Codex 使用 `~/.codex/skills/zhihui-notices/`，其他客户端按自己的 Skill 安装方式。也可在面板“连接 Agent → 快速连接 → 下载 skill”获得 ZIP。压缩包根目录为 `zhihui-notices/`，不要只复制 SKILL.md，需保留 references 和 scripts。安装后重新加载技能或开启新会话，实际可用工具仍由 MCP 密钥和客户端白名单决定。

可直接说：“把这条通知保存到知会”“找一下奖学金通知，给我材料要求”“最近有什么日程安排，做成时间轴”。Codex 可显式使用 `$zhihui-notices`。

skill 会实时查询并按需读取原文；“最近”默认含今天的未来七天。完整日程会核对原文中的活动时间，不能只筛截止日期，避免漏掉没有报名截止的活动。报名截止和活动开始分成独立节点，缺失时分显示“时间未注明”，日期不可靠则单列待确认。时间轴是本地静态快照，包含来源、真实通知编号和日期依据，不代表用户已报名或已创建提醒；重新查询后可生成新版。

可视化脚本需要 Node.js 18 或以上，无 npm 依赖；无文件执行能力的 Agent 可按 skill 输出聊天时间轴或日期表格。工具参数及边界见 [Agent 接入说明](./AGENT_INTEGRATION.md)。

维护者可运行 `pwsh -NoProfile -File standalone/build-skill.ps1` 更新面板下载包及 `releases/zhihui-notices.zip`；构建 Windows 启动包时也会自动更新 skill 包。Skill 目录和打包产物不含密钥、账号和通知数据。

## 数据保存与旧版迁移

独立版默认将账号、密码哈希、会话、密钥哈希和通知保存在 `data/notice-inbox.sqlite`。源码方式运行时位于项目根目录，启动包方式运行时位于“知会本地版”根目录。本地运行时，数据在运行程序的这台电脑上；部署后，数据在服务器的持久存储中。原始密码和完整导入密钥不存入数据库。

- 网页可导入、导出 JSON 通知备份。完整数据库备份应先停止程序，再备份整个 `data` 目录。
- 旧版 JSON 备份可导入，重复通知会跳过，不覆盖已有内容。
- 原浏览器存在 `campus-notice-inbox.v1` 数据时，页面提供迁移入口，迁移不会清除原始数据。换站点地址后，通常需要从旧地址导出 JSON 再导入。
- 旧 OpenAI 登录账号与新邮箱账号不自动绑定，邮箱相同也不会自动取得旧账号的数据。

数据库、实际密钥和填写好的 `.env` 不应提交到公开代码仓库；项目已配置相关忽略规则。

## 部署

项目附带 `notice-inbox-standalone.zip` 独立部署包和 `standalone/` 下的 Docker Compose、Caddy 配置。部署到自己的服务器需要域名、Docker Compose 和持久存储，具体步骤见 [运行和部署说明](./standalone/DEPLOY.md)。

当前尚未部署独立公网版本，也未实际构建 Docker 容器或申请 HTTPS 证书。原 `chatgpt.site` 网站仍是使用 OpenAI 登录的旧托管版，账号和数据与独立邮箱版互不自动同步。

## 验证

```powershell
node --test standalone/server.test.mjs
node --test tests/notices.test.ts
node --test tests/zhihui-skill.test.mjs
node --test standalone/categories.test.mjs
node --check public/app.js
```

已有测试覆盖注册登录、会话、账号隔离、Agent 导入、去重、密钥过期与撤销、重启后持久化和跨站写入防护，使用临时数据库，不修改实际用户数据。此前已通过上述测试，并完成网页自动显示导入通知及 Codex 本地连接验证。

## 源码结构

- `standalone/server.mjs`：独立版 HTTP 服务、页面与 API 入口。
- `standalone/auth.mjs`、`standalone/database.mjs`：账号、会话、导入密钥与 SQLite 数据库。
- `standalone/mcp.mjs`：独立版 MCP 工具与 Agent 导入。
- `standalone/agent-notices.mjs`：受账号隔离的查询、日期筛选、分页和原文读取。
- `standalone/categories.mjs`：按账号保存分类，重命名和删除时原子更新通知归类。
- `standalone/portable/`、`standalone/build-portable.ps1`：Windows 本地启动器、使用说明与打包脚本。
- `standalone/public/`：独立版登录与账号相关界面。
- `public/`、`app/panel.html`：共用通知面板脚本、样式与页面结构。
- `public/desktop.css`：独立版桌面阅读布局与字号优化。
- `skills/zhihui-notices/`：可分发的通知读写 skill 和本地时间轴生成器。
- `lib/notice-input.ts`、`lib/notice-store.ts`：共用输入校验与通知业务。
- `app/api/notices/route.ts`、`app/mcp/route.ts`、`db/schema.ts`、`drizzle/`：原 Sites 托管版接口与数据库结构。

通知原文以纯文本展示，来源链接仅允许 HTTP / HTTPS。服务端根据登录会话或导入密钥确定数据归属，不接收客户端指定的数据所属用户。

## 原 Sites 托管版开发

以下命令仅用于维护原托管版，不是独立邮箱版的启动步骤。要求 Node.js >= 22.13.0。

```powershell
npm run install:ci
npm run db:generate
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_sparkling_frog_thor.sql
npm run dev -- --port 4173 --hostname 127.0.0.1
```

托管版与独立版默认使用同一端口，运行时应先停止另一版本。SQL 命令仅在新本地数据库执行一次，后续按生成的迁移顺序应用。托管版模板仅在本地模拟登录为开发用户，生产环境由 Sites 处理身份认证，线上和本地数据库相互独立。

托管版的额外检查：

```powershell
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

Windows 若 npm 启动器错误地将自身安装路径识别为项目目录，可以用 `node "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js"` 替代 `npm` 命令。
