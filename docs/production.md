# 生产构建、打包与交付

## 环境与支持范围

构建电脑和接收者电脑都需要 Node.js **24.12 或更高版本**，包含 npm。开发推荐 pnpm；下面的命令使用 npm，两者均可用。

发布包包含前端、后端、工作流和生产依赖，**不包含 Node.js 运行时**。它不是双击即开的桌面安装程序。

当前分词依赖 `@node-rs/jieba` 的原生扩展，因此发布包需要匹配目标系统与 CPU。默认打包当前电脑的平台；`npm start` 不会选择、下载或补装其他平台的依赖。不要把 Mac ARM64 的包直接交给 Windows 用户。

## 在开发电脑构建和打包

在仓库根目录执行：

```bash
npm install
npm run build
npm run package
npm run verify:package
```

各命令的职责：

| 命令 | 作用 |
| --- | --- |
| `npm run build:server` | 编译后端和工作流，输出 `dist-server/` |
| `npm run build:web` | 检查前端类型并构建，输出 `dist-web/` |
| `npm run build` | 顺序执行以上两步 |
| `npm run package` | 复制现有构建产物并安装生产依赖，不会自动重新构建 |
| `npm run verify:package` | 把当前平台发布包复制到项目外的临时目录，验证独立启动与实际接口 |

打包过程需要访问 npm 仓库，成功后输出：

```text
release/everything-agent-<platform>-<arch>/
├── dist-web/
├── dist-server/
│   ├── src/workflows/
│   └── web/server/prod-server.js
├── node_modules/
├── package.json
├── package-lock.json
├── EVERYTHING.md
└── README.md
```

例如 Apple Silicon Mac 生成 `release/everything-agent-darwin-arm64/`。打包脚本只生成目录，不自动生成 ZIP；压缩并发送**整个目录**，包括 `node_modules`。不会从项目复制 `.everything`、密钥或聊天数据。

重复打包会删除并重建相同平台的发布目录。日常运行应把包解压到单独的安装目录，或用 `EVERYTHING_HOME` 把数据放到发布目录以外，避免重新打包时丢失数据。

## 接收者启动

1. 安装 Node.js 24.12+，确认 `node --version`。
2. 解压与自己操作系统、CPU 架构匹配的包。
3. 在包含 `package.json` 的目录打开终端，执行：

```bash
npm start
```

发布包已经带生产依赖，接收者无需执行 `npm install` 或构建。浏览器打开终端显示的地址，默认是 `http://127.0.0.1:5173`；保持终端运行，按 `Ctrl+C` 停止。

首次启动自动创建 `.everything` 下的配置和数据库。未配置模型也可以打开页面；在配置页填写自己的 Agent Model 与 Small Model 连接后才能聊天。基础使用不需要 Docker 或 Langfuse，模型请求需要能够访问配置的服务地址。

生产启动同时提供静态页面和 Engine / Agent / Evaluation API，不能只部署 `dist-web`。

## 数据位置和端口

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `EVERYTHING_HOME` | 启动目录 | 数据根目录，实际个人数据在其下的 `.everything/` |
| `EVERYTHING_PORT` | `5173` | Web 服务端口，范围 1–65535 |
| `EVERYTHING_HOST` | `127.0.0.1` | 监听地址，默认仅本机访问 |

`EVERYTHING_HOME` 应指向 `.everything` 的**父目录**。

macOS / Linux 示例：

```bash
EVERYTHING_HOME="$HOME/everything-agent-data" EVERYTHING_PORT=5174 npm start
```

Windows PowerShell 示例：

```powershell
$env:EVERYTHING_HOME = "$env:USERPROFILE\everything-agent-data"
$env:EVERYTHING_PORT = "5174"
npm start
```

更新版本时先停止旧服务，再解压新包，使用相同的 `EVERYTHING_HOME`。不要把个人数据目录一起分享给其他人。

## 工作流和开发模式

- 开发：在仓库执行 `npm run dev:web`，页面可直接编辑 `src/workflows/*.ts`。
- 生产：运行 `dist-server/src/workflows/*.js`；页面仅支持查看、切换和执行，保存接口返回 403。
- 更新工作流：修改项目源码后重新构建、打包并重启生产服务。
- 工作流属于项目代码，不放入 `.everything/workflows`。生产不需要 Vite 或 esbuild 动态加载。

## 其他平台

脚本接受目标参数，例如：

```bash
npm run package -- --platform win32 --arch x64
npm run package -- --platform linux --arch x64
```

参数会传递给 npm 的 `--os` / `--cpu` 以选择可选依赖。它们不提供模拟器，也不代表跨平台验证通过。Linux 还存在 glibc / musl 差异；当前脚本没有提供 `--libc` 选项。最可靠的交付方式是在目标系统构建、打包，并在目标系统完成启动检查。

目前实测通过的是 **macOS ARM64、Node.js v26.8.2、npm 11.19.1**；没有验证 Windows、Linux 或最低支持版本 Node.js 24.12 的运行结果。

## 发布包验证

仓库中的命令：

```bash
npm run verify:package
# 也可以指定与当前电脑兼容的发布目录
npm run verify:package -- /absolute/path/to/package
```

验证会隔离个人数据和 Langfuse 环境变量，检查首页与 JS 静态资源、Agent 初始化、数据库创建、工作流只读权限、真实工作流执行与 observer 事件，最后停止服务并删除临时目录。它不调用真实模型，不证明用户自己的 API Key 或模型连接可用。

## 常见失败

| 现象 | 原因与处理 |
| --- | --- |
| “尚未构建产物”或缺少 `dist-web` | 先在仓库运行 `npm run build`，成功后再打包 |
| npm 在安装生产依赖时长时间重试 | 打包需要联网；检查 npm 仓库、代理和执行环境的联网权限 |
| `connect EPERM 127.0.0.1:7897` | 本次验证中是沙箱禁止连接本机代理；允许相应网络访问后打包成功，无需修改依赖或以管理员身份安装 |
| `listen EPERM` | 执行环境禁止监听本机端口，需要允许本地服务监听后才能做启动验证 |
| `EADDRINUSE` | 端口被占用；设置 `EVERYTHING_PORT` 为其他端口 |
| 无法加载 jieba 原生模块 | 发布包平台/架构不匹配，或复制时遗漏了生产依赖；使用匹配的平台包 |
| `npm start` 提示缺少脚本或找不到文件 | 确认进入解压后包含 `package.json` 的目录，而不是 `dist-web` 或 `dist-server` |
| 构建提示 chunk 超过 500 KB | 当前为前端体积警告；判断命令退出码，警告本身不表示构建失败 |

打包中途失败的目录不能作为完整发布包交付。修正原因后重新运行打包，并以验证命令成功作为交付检查。
