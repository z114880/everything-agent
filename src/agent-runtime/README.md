# Agent Runtime

已实现的本地个人助理集成模块，组合 Agent Loop、真实模型客户端、工具注册表、Memory 与 JSONL Tracer。它不依赖 Web、HTTP 或 Graph 调度器；`agent-loop` 继续负责模型与工具无关的迭代语义。

## 文件组织

```text
agent-runtime/
├── index.ts                  # 模块公开入口
├── agent-runtime.ts          # 回合执行、事件转发、后台任务启动、会话锁与资源生命周期
├── daily-consolidation.ts    # 每日整理的本地时间兜底检查
├── system-prompt.ts          # 运行时基础角色与 Semantic Memory 策略
├── types.ts                  # 回合输入、选项与结果类型
├── configuration/
│   ├── schema.ts             # 配置类型、默认值、边界校验与配置错误
│   └── settings.ts           # 配置读写流程、模型连接探测与公开配置投影
├── integrations/
│   ├── model.ts              # 模型客户端接入与请求预算检查
│   └── memory.ts             # 召回预算、Embedding 客户端与索引绑定
├── events/
│   └── tool-events.ts        # 工具事件脱敏与记忆元数据投影
├── local-config.ts           # 本地配置与规则文件持久化
├── local-data.ts             # 本地数据清理
└── test/                     # 通过公开入口验证行为
```

`agent-runtime.ts` 持有实例状态，负责执行顺序和真实事件发布。配置模块不持有 Memory 或 Tracer 的生命周期；接入模块通过参数接收依赖和事件接收器；工具事件模块只转换事件数据。内部辅助模块不从 `index.ts` 导出，宿主继续通过统一公开入口使用 Runtime。

## 公开接口

通过 `src/index.ts` 或 `everything-agent/agent-runtime` 导入：

```ts
import { createAgentRuntime } from "everything-agent/agent-runtime";

const runtime = createAgentRuntime({
  home: "/absolute/project/.everything",
  envPath: "/absolute/project/.env",
  defaultSystemPromptPath: "/absolute/project/EVERYTHING.md",
});

await runtime.start(); // 恢复已经入队的未完成后台任务
const session = await runtime.createSession();
try {
  const result = await runtime.run(
    { sessionId: session.id, prompt: "你好" },
    { observer: (kind, event) => { /* 宿主消费事件 */ }, signal: new AbortController().signal },
  );
  console.log(result.reply);
} finally {
  await runtime.close();
}
```

路径由宿主提供。实例独立持有 Memory、Tracer、工具和会话锁；不同实例应使用不同数据目录。同一目录的多实例并发协调尚未实现。

- `run(input, options)`：检索记忆、组装上下文、调用 Loop、保存完整回合及 trace，返回类型化结果。
- `await createSession(previousSessionId?)`：复用空会话或创建新会话，不触发整理。
- `await consolidate("daily" | "manual")`：每日首次进入 Agent 页面自动检查或手动全量事实整理；Semantic Memory 为空时返回 skipped 且不创建任务，未配置模型时自动返回 null、手动报错。
- `memory`：现有 MemoryRuntime 的公开操作；`prepareMemory()` 根据当前配置准备检索，并返回 Session Recall 预算。Web 用这些接口组装列表、检索结果等页面响应。
- `getSettings()`、`saveAgentSettings(input)`、密钥清除与预算重置方法：管理配置，返回不含完整密钥的配置快照。
- `readSystemPrompt()`、`saveSystemPrompt(text)`：读写本地规则；首次读取时可从指定默认文件初始化。
- `listSkills()`、`saveSkill(input)`、`deleteSkill(name)`：管理 `.everything/skills/<name>/SKILL.md`；名称受限，写入采用临时文件加 rename，重命名保留目录中的配套资源。
- `getTools()`、`saveToolSettings(input)`：读取脱敏工具目录并保存可配置工具开关。`TAVILY_API_KEY` 只保存在 `.env`，公开目录仅返回是否配置及末四位；下一回合重新读取配置。
- `rebuildEmbeddingIndex()`、`cancelEmbeddingIndexRebuild()`：维护影子索引，退出重建时恢复正常检索配置。
- `clearLocalAgentData()`：停止取后台任务、等待在途处理、刷新 trace 并关闭资源，再清理数据，保留 `EVERYTHING.md`、`skills/` 和 `config.json`；根目录 `.env` 不在清理范围内。调用方负责取得用户确认。
- `close()`：等待后台任务与 trace 落盘并关闭资源；活动回合、数据清理或索引重建期间拒绝关闭。关闭后不允许重新创建资源。

## 执行与可观察性

`manage_memory submit` 每回合绑定当前用户消息证据，使用 `agentModel` 进入统一记忆管理流程；独立的全量事实整理同样使用 Agent Model。删除无需确认令牌，合并与其他变更通过 `memory_*` observer 事件和 JSONL 元数据回放。提交前检查 Loop 截止时间和取消信号；提交持久任务后立即返回 `queued`，不等待 Agent Model 或 embedding。后台单条操作最多 30 秒，不继承聊天取消信号。Small Model 仅用于 retrieval gate。

同一会话的回合串行执行，后续回合读取前一回合保存的工作记忆。不同会话可以并行。Loop 限制 10 次迭代和 5 分钟（300000ms）超时，并接收宿主取消信号；检索与排队阶段不在 Loop 超时范围内。

沿用现有 AgentObserver 事件名称和含义，为转发事件关联 `runId`、`sessionId`，补充上下文来源元数据。每轮以 `skills_discovered` 记录可用目录，`read_skill` 成功后产生不含正文的 `skill_loaded`；对应工具完成事件也只公开名称、描述和正文长度。工具事件在共享执行层进行凭证移除，Session Recall 工具只公开检索元数据。JSONL Tracer 保留既有回合开始、完成、失败及模型/工具追踪语义。静态 Harness 拓扑仍由 `agentHarnessGraph.describe()` 提供，Web 负责转换为画布格式；Runtime 不伪造 Graph 执行事件。

## 本地配置

`local-config.ts` 负责文件持久化。非敏感配置按领域结构保存到 `.everything/config.json`，模型、Embedding 与 Tavily 密钥单独保存到根目录 `.env`；文件值覆盖允许的同名进程环境变量。两类文件都采用临时文件加 rename，不修改 `process.env`。清除密钥时持久化空值，防止下次读取重新继承环境密钥。首次 `start()` 会创建 `.everything`、默认 JSON 配置、`EVERYTHING.md`、`skills/`、数据库和根目录 `.env`（仅含注释占位，不覆盖环境密钥）。缺少默认提示词模板时使用内置中文提示词；重复初始化保留已有配置、密钥和提示词。Web 开发服务器在接受请求前完成初始化；没有 Tavily 密钥时拒绝启用 `search_web`。

Web 的请求校验、Memory action 字符串分发、bootstrap/dashboard 数据和清理确认检查保留在 `web/server/agent-service.ts`。目前尚未提供 CLI 交互入口，但宿主可以直接调用本模块执行回合。

## 后台记忆与归档

Session 归档只在本地提交 Chat Log 和 FTS，不执行 embedding。Session 搜索始终使用 FTS；全局检索模式只控制 Semantic Memory。

Consolidation 按服务端本地自然日自动至多一次，Agent 页面首次进入时检查；`start()` 另外启动每日兜底检查，进程长期运行、页面不刷新时在本地时间 15:00 之后补发一次 daily 整理，`close()` 停止该检查。两条自动路径共用同一份每日去重，只有 Semantic Memory 非空才创建任务，空库不占每日配额。手动 **Consolidate** 可额外执行，自动与手动共用任务互斥。输入仅为全量 semantic facts，不读取 Session，不依赖新建对话。详见 [整理机制](../memory/CONSOLIDATION.md)。

写入和 consolidation 共用持久化串行队列，失败最多执行三次，间隔 1 秒、2 秒。稳定候选 ID 与事务内提交凭据防止中断恢复重复写入。后台每个任务独立 trace JSONL，一次 consolidation 的所有子任务 共用一个文件，不发送到聊天 observer。`runtime.memory.listBackgroundTasks()` 只返回任务元数据，`waitForBackgroundTasks()` 供测试或显式等待使用，聊天不调用。

`subscribeBackgroundEvents(observer)` 订阅独立后台队列的真实事件并返回取消订阅函数，普通记忆写入事件携带 `taskId`、`taskKind`、`runId` 和可用的 `sourceRunId`；整理直接发出 `consolidation_*`，通过 `runId`、`attempt`、`batchIndex`、`modelCallId` 关联运行、尝试、批次与模型调用。订阅不依赖聊天请求生命周期，Web 使用独立 SSE 连接消费；事件继续写入 Trace，不传输记忆正文。

Web 配置页的 Memory Retrieval 区域提供 Retrieval Mode 与 Minimum Similarity，保存后下一回合生效，重新进入 Agent 页时流程图显示当前配置。Semantic 召回节点标明实际模式；Hybrid 展示 BM25 + Dense → RRF → MMR，历史对话召回始终标明 FTS5 + BM25。同一区域提供 Embedding 连接与索引管理，不展示 Query Template / Document Template，Web 保存使用 `{text}`。

### Agent 输出与迭代预算

配置页的运行参数支持修改“单次模型输出”和“Agent 最大迭代”，分别默认 **16,384 tokens**（原 2,048）和 **50 轮**（原 10）。允许范围分别为 1–131,072 tokens 和 1–1,000 轮，保存后对新运行生效，恢复默认会重置这两个值。

也可在 `.everything/config.json` 顶层设置 `maxTokens` 与 `maxIterations`。运行记录 `run_started.settings` 保存实际预算，模型请求使用配置的 `max_tokens`。输入估算、输出预算及 512 tokens 安全余量仍须合计不超过 `modelContextWindow`；输出预算需符合模型服务自身的限制。Agent Loop 超时仍为 300 秒。提高预算不会自动续写被截断的回答。

配套默认预算为 `modelContextWindow: 131072` 与 `sessionRecall.tokenLimit: 32768`（Recall Token Limit）。初始化、缺省配置、配置页和恢复默认保持一致。预留 16,384 输出 tokens 与 512 安全余量后，输入预算为 114,176 tokens；召回预算占上下文窗口的四分之一，为系统提示、当前会话和工具结果留出空间。50 轮是执行上限，不表示预留 50 份输出；每轮仍检查实际累计上下文。

## 系统指令与程序性记忆

每轮将运行时基础角色、Semantic Memory 策略、用户可编辑的 `.everything/EVERYTHING.md` 和 Skills Catalog 组装为系统指令。记忆策略由 `system-prompt.ts` 维护，不写入用户规则文件；编辑用户规则不会移除该策略。召回证据仍通过 system 字段传输，但有明确的不可信历史记录标识，只作为数据使用，不属于行为指令。Working Memory 包含这些内容及会话消息，工具接口随模型请求提供。

图中的 System Prompt 是组装结果，并非一次额外模型调用；现有 `context_assembled` 事件标记其完成，不新增虚构执行事件。提示词指导提交与回复，参数、证据、事务和审计约束仍由工具与记忆模块执行。

Memory 页在 Consolidation 后提供只读 System Prompt 标签页，直接展示 `system-prompt.ts` 导出的运行时提示词正文，不拼接用户规则、Skills 或召回内容，不提供修改和保存入口。
