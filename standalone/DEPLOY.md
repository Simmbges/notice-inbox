# 知会独立版：运行与部署

此版本使用自己的邮箱账号，不依赖 OpenAI 登录。当前交付为可部署版本，尚未部署到独立公网服务器。

## Windows 解压即用

使用 `releases/zhihui-windows-x64.zip`，适用于 Windows 10 / 11 x64。完整解压后，双击“启动知会.cmd”即可打开面板，无需安装 Node.js、npm 或 Docker。停止时双击“停止知会.cmd”，或在启动窗口按 Ctrl+C。

启动包仅监听本机。端口被占用时会自动选择其他端口，重复双击只会打开已经运行的面板；实际地址以启动窗口为准。账号和通知保存在“知会本地版”根目录的 `data` 文件夹，升级和迁移时请保留该目录。

启动包不包含原项目的账号、通知或密钥。原通知通过 JSON 导出、导入迁移，账号和 Agent 密钥需要重新创建。不要把已经使用过、包含 `data` 文件夹的副本直接分享给其他人，应分享原始压缩包。详细说明见包内“使用说明.txt”。

维护者可在 PowerShell 7 中运行 `pwsh -NoProfile -File standalone/build-portable.ps1` 生成启动包。首次构建下载并校验 Node.js 官方 Windows 运行环境，随后使用本地缓存；使用启动包不需要 PowerShell 7，运行时也无需下载依赖。

## 先在自己的电脑上运行

安装 Node.js 24 LTS。在项目根目录执行：

```powershell
node standalone/server.mjs
```

或在 Windows 右键 `standalone/start.ps1`，选择“使用 PowerShell 运行”。无需安装 npm 依赖或执行前端构建。

打开 `http://127.0.0.1:4173/login`，选择“注册账号”，填写邮箱和 12—128 个字符的密码。没有默认账号。当前邮箱只作为账号名，暂未发送验证邮件，也没有邮件找回密码功能。

关闭运行程序的终端会停止服务。再次运行相同命令，原有账号、通知和有效会话仍会保留。

## 数据存在哪里

默认文件为项目根目录下的 `data/notice-inbox.sqlite`。账号、密码哈希、会话、密钥哈希和通知均在该数据库内；原始密码与完整密钥不存入数据库。各账号的通知相互隔离。

需要备份时先停止程序，备份整个 `data` 目录。程序停止后再恢复同一目录，避免数据库写入过程中只复制主文件而遗漏 WAL 数据。

不要把数据库文件、实际密钥或填写好的 `.env` 提交到公开代码仓库；它们已加入忽略规则。

## 有服务器后部署

项目附带 Docker Compose 配置。需要服务器、一个已指向该服务器的域名，以及 Docker Compose；80/443 端口需要允许访问。

1. 把项目上传到服务器（独立部署包即可，不需要 `node_modules`）。
2. 进入项目中的 `standalone` 文件夹。
3. 复制 `.env.example` 为 `.env`，将 `DOMAIN` 改为自己的域名，不带 `https://`。
4. 运行：

```sh
docker compose up -d --build
```

然后访问自己的 `https://域名`。Caddy 按配置申请并续期证书，前提见 [Caddy 官方 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。部署后才可供其他人的电脑和远程 Agent 访问。

程序容器使用非 root 用户，数据库保存在 Docker 的 `notice-data` 持久卷。重新构建镜像不会删除通知。停止服务用 `docker compose down`；不要附加删除数据卷的参数，除非明确要清空账号和通知。

查看日志：`docker compose logs --tail=100 app`。本次环境没有 Docker，已检查 Compose 语法及程序逻辑，尚未实际构建容器、申请证书或做公网测试。

## 如果使用其他 Node 托管平台

启动命令仍为 `node standalone/server.mjs`，要求 Node.js 24 和持久磁盘。需要配置：

| 环境变量 | 示例 | 用途 |
|---|---|---|
| `APP_URL` | `https://notice.example.com` | 用户访问的固定地址，末尾不带斜杠 |
| `HOST` | `0.0.0.0` | 容器或平台内的监听地址 |
| `PORT` | `3000` | 平台指定的监听端口 |
| `DATA_DIR` | `/data` | 持久磁盘目录 |
| `NODE_ENV` | `production` | 要求 HTTPS 地址并使用安全会话 Cookie |
| `TRUST_PROXY` | `true` 或不设置 | 仅在程序只能经可信反向代理访问时开启 |

`/healthz` 是健康检查地址。探测请求的 Host 应与 `APP_URL` 一致。程序不能部署为纯静态网页；没有持久磁盘的平台会在实例被替换时丢失数据。当前数据库适合单个程序实例，共享同一数据文件时不要运行多副本。

## Agent 如何接入

登录面板，点击“连接 Agent”，为 Agent 创建一个密钥并立即复制。密钥 90 天有效、只能导入，可以在面板撤销。无需把网页登录密码交给 Agent。

- 支持 MCP 与自定义 Bearer Token 的客户端：服务地址为 `https://你的域名/mcp`，认证头是 `Authorization: Bearer 你的密钥`。
- 支持 HTTP 工具的 Agent：向 `https://你的域名/api/agent/notices` 发送 POST JSON，使用相同的认证头。

请求示例与详细边界见项目根目录的 `AGENT_INTEGRATION.md`。连小理通知导入已由用户实测通过。远程 Agent 不能通过它自己的 `127.0.0.1` 访问你电脑里的程序，需要先部署到可访问的服务器。

## 从旧版迁移通知

在旧网站导出 JSON 备份，再在独立版登录后点击导入备份。原浏览器 localStorage 中有旧通知时，面板也会显示迁移入口。不同站点地址的浏览器存储互不相通，因此换域名后通常需要 JSON 备份迁移。

旧 OpenAI 登录账号与新邮箱账号没有自动绑定，不会仅因邮箱相同就取得旧账号的数据。

## 验证和实现依据

源码项目可运行 `node --test standalone/server.test.mjs`。测试使用临时数据库，覆盖注册登录、权限、密钥导入与撤销、退出、重启后持久化和防止跨站写入。另保留原有通知业务测试 `node --test tests/notices.test.ts`。

密码使用 Node.js 的 scrypt，参数参考 [OWASP 密码存储说明](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)；会话使用 HttpOnly Cookie，生产环境开启 Secure，结合来源检查保护写入，参考 [OWASP 会话管理说明](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)。数据库使用 [Node.js 24 内置 SQLite](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)。
