# Evaluation

已实现 Langfuse v4 固定数据集的真实环境评估。Langfuse 管理数据集和平台评估器，本地 Everything Agent 执行任务；支持从 Langfuse remote experiment trigger（数据集页面的 via Webhook）或本地 Evaluation 页面启动。

## 部署和启动

```bash
pnpm run langfuse:up
pnpm run dev:web
```

首次部署自动生成 `.langfuse/compose.env`，包含项目 API 凭证和管理员随机密码。Langfuse 地址为 `http://localhost:3300`。后端读取该文件中的 `LANGFUSE_INIT_PROJECT_*`，不把平台密钥发送给浏览器。详见 [Docker 部署说明](../../deploy/langfuse/README.md)。

打开 Evaluation → 连接平台，选择数据集，可按需填写 Experiment 名称前缀，点击「Run Experiment」即可从本地发起运行。

在 Langfuse 中选择数据集 → 进入 **Experiments** 标签页 → 右上角 **Run experiment** → 在 **Run Experiment** 弹窗里选 **via Webhook** 卡片：

- 首次点击卡片上的 Configure，进入 **Set up remote experiment trigger in UI**。URL 填回调地址 `http://evaluation-gateway/trigger`。该地址是 Docker 内部网关，平台会提示明文 HTTP，属预期提示。
- Default config：`{}`，或填写 `{"name":"Everything Agent"}` 指定 Experiment 名称前缀。本地入口在运行区提供同名字段，两条入口的 config 都只承载名称，不承载 terminal、memorySnapshot 等运行开关。
- Sign requests：保持关闭。开启后平台只额外发送 `x-langfuse-signature`，本地网关不校验它；鉴权始终由下方 authorization header 承担。
- Enabled：打开，否则平台不允许触发并提示 enable webhook。
- Advanced Options → Custom headers：名称填 `authorization`，值为 Evaluation 页面“复制 authorization 值”获得的内容，标记为 Secret。Langfuse 会拒绝覆盖 `content-type`、`user-agent`、`x-langfuse-signature` 等由它自己添加的保留头。
- 保存后卡片按钮变为 **Run**。点击它打开 **Run remote dataset run**，可确认或临时修改本次 config，再点击 Run 触发；触发成功后平台会创建本次 Experiment 并把执行轨迹关联到对应数据集条目。
- 本地 Web 服务必须保持运行。

Docker 内部网关使用 80 端口，满足 Langfuse 的 Webhook 端口限制；只有该网关主机加入平台白名单。网关不映射宿主端口，只转发 `/trigger`，本地 `4319` 接口要求独立 Bearer 令牌和匹配的项目 ID。远程入口不能管理本地文件、修改运行时配置或批准工具操作。

## 启动入口

本地页面和 Langfuse remote experiment trigger（via Webhook 卡片）的回调进入同一个执行层：都按启动时刻固定数据集版本，读取数据集 metadata 的 `terminal` 与 `memorySnapshot`，共用并发上限、隔离目录、审批、超时和结果回传策略，因此“一次只允许一个 Experiment”的限制也是共享的，两条入口会互相阻塞。

差别只在发起位置和结果归属：

- 平台入口由 Langfuse 创建本次 Experiment，Experiment 记录、名称和版本留在平台；回调额外携带数据集 ID，运行时校验 ID 与名称一致。远程入口只能启动 Experiment，不能管理本地文件、修改运行时配置或批准工具操作，启动失败时平台只收到统一的 400 提示，看不到具体原因。
- 本地入口（页面按钮「Run Experiment」）不创建平台 Experiment 记录，运行记录只保存在 `.evaluations/langfuse-v4/`，执行轨迹仍关联到对应数据集条目；本地在运行区填写 Experiment 名称前缀，留空或只填空白字符时使用默认前缀 Everything Agent，与平台 Default config 的 `name` 语义一致，失败原因直接显示在页面上。

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

最多 20 轮，每轮最多 40000 字符；单次 Experiment 最多 200 条启用的用例。预期输出使用 Langfuse 的 `expectedOutput` 字段。用例不支持任意路径、工具定义、模型配置覆盖或 fixture；始终调用实际 Runtime。终端工具额外要求数据集的 Langfuse metadata 显式设置 `{"terminal":true}`，同时日常配置已启用终端。数据集开关统一应用于全部用例，不读取单个 dataset item 的同名字段；未设置或为 `false` 时关闭终端，非布尔值明确报错。运行开始后固定本次开关，并在运行摘要的 `terminalEnabled` 和 trace 的 `langfuse.experiment.metadata.terminal` 中记录数据集授权值（实际可用性仍取决于日常配置与沙箱）。例如数据集 metadata 可设置为 `{"memorySnapshot":false,"terminal":true}`。

## 执行边界

- 一次只运行一个 Experiment，默认最多 3 条用例并行，可通过后端环境变量 `EVERYTHING_EVALUATION_CONCURRENCY` 调整。启动时固定数据集版本以及本地配置、系统提示和 Skills；每条用例使用独立 Runtime、数据库和终端工作目录，多轮用例内部复用同一会话。
- 本地启动与 Langfuse 回调启动统一读取数据集 metadata 的 `memorySnapshot`，例如 `{"memorySnapshot":true}`；不读取用例 metadata 或远程 Default config 的同名字段。本地页面不再提供该开关。未设置或为 `false` 时使用空白评估记忆；非布尔值明确报错。运行读取数据集后固定本次配置。为 `true` 时用 SQLite 的 `VACUUM INTO` 生成日常事实、会话和索引的一致副本（同步执行，不使用 `node:sqlite` 的 `backup()`——它依赖线程池完成回调唤醒事件循环，进程空闲时可能延迟数十秒），并清除副本中旧的后台任务；每条用例从同一份快照开始，不回写日常 `.everything`。快照目标文件必须不存在，重复写入同一路径会明确失败而不是静默覆盖。
- 空白评估库会为已配置的 Embedding 初始化空索引，不改变日常的检索模式。记忆写入及其后台任务均在评估副本运行。
- 使用真实模型、搜索和工具，产生真实费用。终端工作目录位于评估副本内，继续沿用原有沙箱、确认策略、迭代上限和每回合 5 分钟超时。每条用例另有 10 分钟总执行信号。
- 需要确认时只暂停该用例，本地页面批准后继续。拒绝、超时、取消、工具错误或达到迭代上限均明确记录，不能当成完整执行成功。
- 取消不会撤销已经发生的外部操作。进程重启将未完成 Experiment 标为中断，不自动重复真实工具调用。

## 页面和可观测性

页面首屏只常驻连接状态与两处配置入口：数据集 Metadata 示例为 `{"terminal":false,"memorySnapshot":false}`，两个开关默认均为 false；remote experiment trigger 的 Default config 示例为 `{"name":"Everything Agent"}`，默认名称前缀为 Everything Agent，最终名称附加运行 ID 短码。本地运行区的名称前缀输入框使用同一默认值，最长 120 字符，留空时提交的启动参数不含名称；本地页面不提供 terminal 与 memorySnapshot 开关，两者只从数据集 metadata 读取。Experiment 详情展示本次读取的两个开关及最终 Experiment 名称，不区分未配置与显式 false。终端开关表示数据集授权，实际可用性仍取决于日常工具配置和沙箱。

Experiment 记录每页 10 条，显示总数和页码，翻页与进度轮询保留选中的 Experiment。

平台侧的一次性配置步骤（回调地址、Default config、Custom headers，以及“复制 authorization 值”）收在「数据集与实验」分区的「平台启动步骤」弹窗里，与本地启动入口同一行，页面不再常驻长说明；弹窗底部的复制按钮同样只在本地入口已配置时可用。


Evaluation 展示连接状态、数据集、运行记录、用例输入与输出、预期结果、平台评分、模型、工具调用次数、耗时、模型返回的输入／输出 Token，以及按 observer 顺序记录的执行事件。Token 统计来自 Agent 主循环模型；未返回用量时显示 `—`，不伪造费用或用量。

Experiment 和模型／工具子节点通过官方 OTLP HTTP 协议回传到 Langfuse v4，携带 experiment、dataset、item 和根 observation 关联字段。Engine 的 `Graph.describe()` 与调度不受影响。

Experiment 根 Agent observation 另外携带脱敏执行痕迹 `langfuse.observation.metadata.execution_trace`，按顺序列出每次工具调用的工具名、终端命令、退出码、输出长度和成败。痕迹是必要的：Langfuse v4 的评估器只读被规则匹配到的那一个 observation，不会加载同一 trace 的兄弟或子 observation，因此工具执行证据只有写在根节点上，模型裁判才可能看到。终端命令是判断“跑的到底是不是那条命令”的唯一依据，因此包含在内，但截断到 500 字符；完整命令仍留在用例副本的 Runtime trace JSONL 里。

执行状态、同步状态、评分分开保存。HTTP 错误或 OTLP 部分拒收会显示同步失败；“刷新评分／重试同步”只重传同一组 trace/span ID，不重新调用 Agent。平台评分通过 v3 Scores API 查询用例根 observation，尚未收到评分时显示等待。首版不配置隐含质量阈值，也不把“执行完成”或“收到评分”推断为通过。

请在 Langfuse 管理评估器，目标选择 Experiment 根 Agent observation，并按数据集或 `evaluation` 环境筛选。评估器只按 observation 取值，看不到子节点，因此需要核对执行过程时，在裁判提示词里加一个变量（例如 `{{execution_trace}}`），映射来源选 Observation → Metadata，JSONPath 填 `$.execution_trace`。模型裁判的模型连接和评分规则由平台管理，需要自行配置；本模块不自动创建付费裁判。

## 本地数据和配置

运行记录位于 `.evaluations/langfuse-v4/`，配置和会话副本在同目录的 Experiment 子目录；不兼容、不读取回退之前留下的其他评估格式。此目录与 `.langfuse/` 均已加入 Git 忽略规则。

评估展示与平台回传移除已知凭证及敏感键；不上传完整模型请求、检索记忆上下文或工具原始输出。评估事件按固定键名投影，只保留标识、枚举和统计字段：终端只保留命令（截断到 500 字符）、退出码和输出长度，工作目录与输出正文不写入；技能只额外保留技能名和指令长度，说明文字不写入。工具结果按键名筛选，没有专用脱敏的工具（例如 `search_web`、`get_current_time`）不会带出原始结果，检索查询也不写入。审批相关事件保留命令供本地审计，这类事件不回传平台。数据集输入、实际回复及预期输出会作为评估内容回传到配置的 Langfuse。副本里的原始本地会话仍是私人数据，不应提交。

已有独立 Langfuse 部署可用 `LANGFUSE_BASE_URL`、`LANGFUSE_PUBLIC_KEY`、`LANGFUSE_SECRET_KEY`、`LANGFUSE_PROJECT_ID` 覆盖连接配置。`EVERYTHING_EVALUATION_PORT` 可修改本机回调监听端口，启动 Docker 和 Web 时应使用同一值。完整 Compose 的管理端口固定为 3300，对象存储端口为 9390。

## 公开接口和验证

通过 `everything-agent/evaluation` 或 `src/index.ts` 导入 `EvaluationService`、`LangfuseEvaluationClient`、`evaluationWebhook`；宿主注入数据目录和平台客户端。内部运行层复用 `createAgentRuntime`，不初始化第二套工具或模型协议。

```bash
pnpm exec vitest run src/evaluation/test web/test/evaluation-page.test.tsx deploy/langfuse/test
pnpm run build
pnpm run test:coverage
```

评估 Runtime 显式关闭日常 Langfuse exporter，保留独立的 Experiment 轨迹上传和同步状态，避免宿主环境启用日常导出后生成重复 trace。

### 评估并发配置

启动 Web 后端时设置进程环境变量（修改后需重启）：

```bash
EVERYTHING_EVALUATION_CONCURRENCY=5 pnpm run dev:web
```

未设置时默认 3，必须是正安全整数；空值、零、负数、小数及非数字会导致评估服务初始化失败，页面显示配置错误。实际 worker 数不超过用例数。本地页面和 Langfuse remote experiment trigger 回调共享此配置，远程 Default config 不能覆盖；该变量不从 `.everything/.env` 或 `.langfuse/compose.env` 读取。直接使用公开接口时传入 `new EvaluationService({ directory, sourceHome, client, concurrency: 5 })`，省略 `concurrency` 同样默认 3。
