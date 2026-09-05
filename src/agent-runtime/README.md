# Agent Runtime

已实现的本地个人助理集成模块，组合 Agent Loop、真实模型客户端、工具注册表、Memory 与 JSONL Tracer。它不依赖 Web、HTTP 或 Graph 调度器；`agent-loop` 继续负责模型与工具无关的迭代语义。

## 公开接口

通过 `src/index.ts` 或 `everything-agent/agent-runtime` 导入：

```ts
import { createAgentRuntime } from "everything-agent/agent-runtime";

const runtime = createAgentRuntime({
  home: "/absolute/project/.everything",
  envPath: "/absolute/project/.env",
  defaultSystemPromptPath: "/absolute/project/EVERYTHING.md",
});

await runtime.start(); // 调度上次退出时未完成的 consolidation
const session = runtime.createSession();
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
- `createSession(previousSessionId?)`：创建会话，可为前一会话调度 consolidation。
- `memory`：现有 MemoryRuntime 的公开操作；`prepareMemory()` 根据当前配置准备检索，并返回 Session Recall 预算。Web 用这些接口组装列表、检索结果等页面响应。
- `getSettings()`、`saveAgentSettings(input)`、密钥清除与预算重置方法：管理配置，返回不含完整密钥的配置快照。
- `readSystemPrompt()`、`saveSystemPrompt(text)`：读写本地规则；首次读取时可从指定默认文件初始化。
- `rebuildEmbeddingIndex()`、`cancelEmbeddingIndexRebuild()`：维护影子索引，退出重建时恢复正常检索配置。
- `clearLocalAgentData()`：等待 consolidation、刷新 trace 并关闭资源，再清理数据，仅保留 `EVERYTHING.md`。调用方负责取得用户确认。
- `close()`：等待后台任务与 trace 落盘并关闭资源；活动回合、数据清理或索引重建期间拒绝关闭。关闭后不允许重新创建资源。

## 执行与可观察性

同一会话的回合串行执行，后续回合读取前一回合保存的工作记忆。不同会话可以并行。Loop 仍限制 10 次迭代和 60 秒超时，并接收宿主取消信号；检索与排队阶段不在 Loop 超时范围内。

沿用现有 AgentObserver 事件名称和含义，为转发事件关联 `runId`、`sessionId`，补充上下文来源元数据。工具事件在共享执行层进行凭证移除，Session Recall 工具只公开检索元数据。JSONL Tracer 保留既有回合开始、完成、失败及模型/工具追踪语义。静态 Harness 拓扑仍由 `agentHarnessGraph.describe()` 提供，Web 负责转换为画布格式；Runtime 不伪造 Graph 执行事件。

## 本地配置

`local-config.ts` 负责文件持久化。读取时合并允许的进程环境字段与配置文件，文件优先；写入采用临时文件加 rename，不修改 `process.env`。清除密钥时持久化空值，防止下次读取重新继承环境密钥。只更新指定字段、保留无关配置与注释，并折叠被更新字段的重复定义。

Web 的请求校验、Memory action 字符串分发、bootstrap/dashboard 数据和清理确认检查保留在 `web/server/agent-service.ts`。目前尚未提供 CLI 交互入口，但宿主可以直接调用本模块执行回合。
