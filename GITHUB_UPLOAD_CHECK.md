# GitHub 上传前检查

检查日期：2026-10-20。检查起点：`5f2d0c1`，包含当时全部 196 个受 Git 管理的文件及 5 次提交历史。本次只进行检查、检查配置修正和文档更新，尚未上传或配置远程仓库。

## 检查结果

| 项目 | 结果 |
|---|---|
| 凭据与个人数据 | 当前文件、Git 历史和其中的 skill ZIP 未发现真实密钥、私钥、数据库或个人电脑路径；密码字面量命中均为隔离测试中的自编凭据 |
| Git 忽略规则 | 实测 `data/`、`.env`、本地缓存、`node_modules/`、截图及发布包被忽略；无已跟踪文件落入这些忽略规则；无须填写真实配置的 `.env.example` 保留 |
| 自动测试 | 本机完整测试 144 项通过，包含现有 Windows 启动包的实际运行测试 |
| 干净源码 | 只复制受 Git 管理的文件，不复制依赖、本机缓存或数据；136 项通过，1 个启动包测试组因未构建发布包而跳过 |
| 类型与构建 | TypeScript `--noEmit` 和原托管版构建通过；`package.json` 与锁文件的依赖声明一致 |
| ESLint | 修正误扫描临时副本和发布目录的问题后，0 错误、11 个原有警告；警告主要涉及原生页面导航、样式加载和未使用变量 |
| 分发包 | skill ZIP、独立部署 ZIP、Windows 启动包均通过 ZIP 完整性检查，未包含数据目录、数据库或凭据文件 |
| 依赖安全 | **未全通过**：npm 官方安全接口报告 30 个受影响依赖包，需后续处理 |
| 开源许可 | 根目录尚无项目 `LICENSE`，需维护者确定许可；保留现有第三方许可文件 |

凭据检查使用格式匹配、文件路径检查和测试用例核对；结果仅反映本次检查范围。测试使用临时数据，没有读取或改写实际账号数据库。

## 待处理的依赖安全项

2026-10-20 通过 npm 官方安全接口查询现有锁文件，报告：严重 1、高危 21、中危 7、低危 1，共 30 个受影响依赖包。该数量按包统计，包含传递依赖，不等同于 30 个互不重复的漏洞编号。

主要直接依赖包括 `next`、`react-server-dom-webpack`、`vite`、`vinext`、`@cloudflare/vite-plugin`、`wrangler` 和 `drizzle-kit`。其中 Next.js 的严重项来自 [GHSA-vcvr-r3jv-pc5j](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j)。是否实际可利用还取决于具体运行路径与使用功能。

当前独立邮箱版以 `node standalone/server.mjs` 启动，使用 Node.js 内置模块和项目源码。干净源码测试已验证它不需要安装 npm 依赖。这些 npm 审计项涉及保留的原 Sites 托管版及其开发、构建工具链，不能直接等同于独立版存在同样可利用的问题，也不代表独立版已经完成全面安全审计。

本次未批量升级框架依赖。修复时应逐项核对兼容性、更新锁文件，重跑类型检查、构建和测试；部分自动修复建议涉及大版本切换或降级，不应直接执行 `npm audit fix --force`。使用原托管版对外部署前，应完成这部分修复。

## 上传和发布范围

- 源码仓库使用当前 `notice-inbox` 项目中的受 Git 管理文件，不上传外层比赛材料或本地工作目录的全部文件。
- 账号、事件和密钥仍留在本机 `data/`。不要强制加入被忽略的数据库、填写后的 `.env` 或客户端凭据配置。
- `releases/zhihui-windows-x64.zip`、对应 `.sha256`、skill 分发包和独立部署 ZIP 适合作为 Releases 附件单独发布。源码不包含 `releases/`，下载源码后可直接按 README 运行独立版。
- `.openai/hosting.json` 是保留给原托管版的项目和资源标识配置，不包含访问密钥；独立版不依赖它。它不能替代新维护者自己的托管环境配置。
- 公开前确定项目许可，并保留 Node.js 运行环境及现有 vendor 文件所附许可。

## 复查命令

Node.js 24，无需安装依赖即可运行独立版测试：

```powershell
node --test tests/*.test.mjs tests/*.test.ts standalone/*.test.mjs
```

原托管版工具链在安装锁文件依赖后检查：

```powershell
npm ci
node node_modules/typescript/bin/tsc --noEmit
npm run lint
npm run build
npm audit --registry=https://registry.npmjs.org
git diff --check
```

启动包测试需要 Windows 和已构建的 `releases/zhihui-windows-x64.zip`；没有该文件时相应测试组会跳过。依赖安全报告会随公告更新，应在发布时重新查询。
