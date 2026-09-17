# 本地 Langfuse v4

项目保留本地记忆、Session Recall、Skills、工具执行和隔离评估；Langfuse 提供执行分析、固定数据集、执行历史与自动评分。使用官方 v4 OTLP HTTP/JSON 和 Scores API，避免全局追踪状态影响现有 observer。

## 启动

安装并启动 Docker Desktop 后，在项目根目录运行：

```bash
pnpm run langfuse:setup
pnpm run langfuse:up
```

打开 [本地 Langfuse](http://localhost:3300)。账号 `admin@everything.local`；随机密码保存在 `.langfuse/compose.env` 的 `LANGFUSE_INIT_USER_PASSWORD`。初始化同时创建 Everything Agent 项目与项目 API Key。已有配置不会被覆盖。

Compose 基于 [Langfuse 官方部署文件](https://github.com/langfuse/langfuse/blob/main/docker-compose.yml)，运行 Web、Worker、PostgreSQL、ClickHouse、Redis 与 MinIO。Web 的 3300 和对象存储的 9390 端口只绑定 `127.0.0.1`，数据库没有宿主端口。关闭服务使用 `pnpm run langfuse:down`，不删除数据卷。

部署凭证保存在 `.langfuse/compose.env`，应用连接保存在 `.everything/langfuse.env`，两者权限为 0600，均被 Git 忽略。不要将它们加入数据集或提交。

## 应用连接

启动 `pnpm run dev:web` 后，新 Runtime 自动读取 `.everything/langfuse.env`。修改日常追踪连接需要重启应用；每次评估发布重新读取连接，失败后可在 Evaluation 页面重新同步。环境变量优先于文件。

| 配置 | 用途 |
| --- | --- |
| `LANGFUSE_ENABLED=true` | 显式启用；其他值禁用 |
| `LANGFUSE_BASE_URL=http://localhost:3300` | 本地服务地址 |
| `LANGFUSE_PROJECT_ID=everything-agent` | 页面详情链接使用的项目 ID |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` | 服务端项目凭证 |
| `LANGFUSE_CAPTURE_CONTENT=false` | 日常模型输入、回复和工具内容上传开关 |
| `LANGFUSE_EVALUATION_CAPTURE_CONTENT=false` | 离线测试内容上传开关，与日常运行独立 |

默认只上传执行结构、统计、标识和分数。只在确认内容可上传时开启对应开关。自动记忆事件及 Skill 事件本身依然只包含元数据；完整模型请求若开启上传可能包含记忆、历史对话和技能正文。语义评估依赖平台裁判，需要开启评估正文上传开关；默认数据集仅含模拟内容。

## 评估

Evaluation 页面通过 API 保存固定数据集，运行当前 Agent，并将执行证据发布为 Langfuse experiment。数据集保存采用不可变远端版本，运行只读取固定版本。CLI 预留入口为 `pnpm run evaluate [数据集 ID...]`，当前不接 CI。

在 Langfuse 创建自动模型裁判，筛选 `evaluation` 环境的评估根 observation，设为 100% 采样；评分名称默认 `task_quality`，数值范围 0–1。将 observation input 中的 turns、criteria、expectedOutput 和 output 中的 replies、tools、memory、files 映射到裁判提示词。未配置自动裁判时，应用会保留“等待评分／证据不足”，不会自动通过。

详细的数据集协议、事件和失败处理见 [Evaluation](../../src/evaluation/README.md)。

## 验证

测试通过模拟 Langfuse 接口验证协议、关联、隐私边界与故障，避免把测试发送到真实项目：

```bash
LANGFUSE_ENABLED=false pnpm test
LANGFUSE_ENABLED=false pnpm run test:coverage
pnpm run build
```

真实部署验收只使用人工合成用例；检查服务健康、OTLP 接收、实验查询与分数读取。首次拉取镜像和数据库初始化需要一定时间。

服务启动后运行 `pnpm run langfuse:verify`，会用本地模拟模型驱动真实 Runtime，验证 Skills、Session Recall、后台记忆写入、固定数据集、单版本运行及分数接收；合成验收记录留在 Langfuse 中，本地临时执行目录自动清除。
