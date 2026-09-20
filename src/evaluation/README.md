# Evaluation

已实现 Langfuse v4 固定数据集的真实环境评估。Langfuse 管理数据集和平台评估器，本地 Everything Agent 执行任务；支持从 Langfuse Custom Experiment 或本地 Evaluation 页面启动。

## 部署和启动

```bash
pnpm run langfuse:up
pnpm run dev:web
```

首次部署自动生成 `.langfuse/compose.env`，包含项目 API 凭证和管理员随机密码。Langfuse 地址为 `http://localhost:3300`。后端读取该文件中的 `LANGFUSE_INIT_PROJECT_*`，不把平台密钥发送给浏览器。详见 [Docker 部署说明](../../deploy/langfuse/README.md)。

打开 Evaluation → 连接平台，选择数据集，即可从本地发起运行。

在 Langfuse 中选择数据集 → Start Experiment → Custom Experiment → ⚡：

- 回调地址：`http://evaluation-gateway/trigger`。
- Default payload：`{"memorySnapshot":false}`。可选 `name` 指定实验名称前缀。
- Advanced Options → Custom headers：名称填 `Authorization`，值为 Evaluation 页面“复制 Authorization 值”获得的内容，标记为 Secret。
- 保存并点击 Run。本地 Web 服务必须保持运行。

Docker 内部网关使用 80 端口，满足 Langfuse 的 Webhook 端口限制；只有该网关主机加入平台白名单。网关不映射宿主端口，只转发 `/trigger`，本地 `4319` 接口要求独立 Bearer 令牌和匹配的项目 ID。远程入口不能管理本地文件、修改运行时配置或批准工具操作。

## 数据集输入

每个用例支持以下一种输入：

```json
"请调用时间工具告诉我今天的日期"
```

```json
{"prompt":"请搜索今天的天气"}
```

```json
{"turns":["本次对话代号是青禾，不要写入长期记忆。","本次对话的代号是什么？"]}
```

最多 20 轮，每轮最多 40000 字符；单次实验最多 200 条启用的用例。预期输出使用 Langfuse 的 `expectedOutput` 字段。用例不支持任意路径、工具定义、模型配置覆盖或 fixture；始终调用实际 Runtime。终端工具额外要求该用例的 Langfuse metadata 显式设置 `{"terminal":true}`，同时日常配置已启用终端；未标记的用例不会获得终端工具。

## 执行边界

- 一次只运行一个实验，最多两条用例并行。启动时固定数据集版本以及本地配置、系统提示和 Skills；每条用例使用独立 Runtime、数据库和终端工作目录，多轮用例内部复用同一会话。
- 默认空白评估记忆。`memorySnapshot: true` 用 SQLite 在线备份复制日常事实、会话和索引，并清除副本中旧的后台任务；每条用例从同一份快照开始，不回写日常 `.everything`。
- 空白评估库会为已配置的 Embedding 初始化空索引，不改变日常的检索模式。记忆写入及其后台任务均在评估副本运行。
- 使用真实模型、搜索和工具，产生真实费用。终端工作目录位于评估副本内，继续沿用原有沙箱、确认策略、迭代上限和每回合 5 分钟超时。每条用例另有 10 分钟总执行信号。
- 需要确认时只暂停该用例，本地页面批准后继续。拒绝、超时、取消、工具错误或达到迭代上限均明确记录，不能当成完整执行成功。
- 取消不会撤销已经发生的外部操作。进程重启将未完成实验标为中断，不自动重复真实工具调用。

## 页面和可观测性

Evaluation 展示连接状态、数据集、运行记录、用例输入与输出、预期结果、平台评分、模型、工具调用次数、耗时、模型返回的输入／输出 Token，以及按 observer 顺序记录的执行事件。Token 统计来自 Agent 主循环模型；未返回用量时显示 `—`，不伪造费用或用量。

实验和模型／工具子节点通过官方 OTLP HTTP 协议回传到 Langfuse v4，携带 experiment、dataset、item 和根 observation 关联字段。Engine 的 `Graph.describe()` 与调度不受影响。

执行状态、同步状态、评分分开保存。HTTP 错误或 OTLP 部分拒收会显示同步失败；“刷新评分／重试同步”只重传同一组 trace/span ID，不重新调用 Agent。平台评分通过 v3 Scores API 查询用例根 observation，尚未收到评分时显示等待。首版不配置隐含质量阈值，也不把“执行完成”或“收到评分”推断为通过。

请在 Langfuse 管理评估器，目标选择实验根 Agent observation，并按数据集或 `evaluation` 环境筛选。模型裁判的模型连接和评分规则由平台管理，需要自行配置；本模块不自动创建付费裁判。

## 本地数据和配置

运行记录位于 `.evaluations/langfuse-v4/`，配置和会话副本在同目录的实验子目录；不兼容、不读取回退之前留下的其他评估格式。此目录与 `.langfuse/` 均已加入 Git 忽略规则。

评估展示与平台回传移除已知凭证及敏感键；不上传完整模型请求、检索记忆上下文或工具原始输出。数据集输入、实际回复及预期输出会作为评估内容回传到配置的 Langfuse。副本里的原始本地会话仍是私人数据，不应提交。

已有独立 Langfuse 部署可用 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_PROJECT_ID` 覆盖连接配置。`EVERYTHING_EVALUATION_PORT` 可修改本机回调监听端口，启动 Docker 和 Web 时应使用同一值。完整 Compose 的管理端口固定为 3300，对象存储端口为 9390。

## 公开接口和验证

通过 `everything-agent/evaluation` 或 `src/index.ts` 导入 `EvaluationService`、`LangfuseEvaluationClient`、`evaluationWebhook`；宿主注入数据目录和平台客户端。内部运行层复用 `createAgentRuntime`，不初始化第二套工具或模型协议。

```bash
pnpm exec vitest run src/evaluation/test web/test/evaluation-page.test.tsx deploy/langfuse/test
pnpm run build
pnpm run test:coverage
```
