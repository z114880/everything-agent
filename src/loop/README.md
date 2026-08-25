# Agent Loop

`runAgentLoop` 实现一次有界的 `observe → reason → act → repeat` Agent 回合。它不初始化模型 SDK、工具、数据库或 UI，而是通过参数注入这些能力。

## 依赖接口

模型客户端采用 Anthropic Messages 风格的最小接口：

```ts
const client = {
  messages: {
    async create({ model, system, messages, tools, max_tokens, signal }) {
      return {
        content: [{ type: "text", text: "完成" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  },
};
```

工具注册表只需公开 schema 和安全执行入口：

```ts
const tools = {
  schemas() {
    return [{
      name: "read_note",
      description: "读取笔记",
      input_schema: { type: "object", properties: {} },
    }];
  },
  async execute(name, args, notify, { signal }) {
    return `已执行 ${name}`;
  },
};
```

第四个参数还包含 `deadline`、`iteration` 和 `toolUseId`，长时间运行的工具应读取 `signal` 并主动中断底层 I/O。工具注册表负责名称查找、参数校验、读写权限、外部写操作确认和审计。模型只能请求注册过的工具，不能绕过注册表直接执行操作。

## 使用方式

```ts
import { runAgentLoop } from "everything-agent";

const messages = [{ role: "user", content: "读取今天的笔记" }];
const result = await runAgentLoop({
  client,
  model: "model-id",
  system: "你是个人助理",
  messages,
  tools,
  maxIterations: 10,
  timeoutMs: 30_000,
  observer(kind, event) {
    console.log(kind, event);
  },
});

console.log(result.reply);
```

传入的 `messages` 会被原地追加：模型响应加入 assistant 消息，工具结果加入 user 消息。这样下一次推理可以观察本轮已经执行的动作。

## 结束条件与错误

- 模型不再请求工具时自然结束，`stopReason` 为 `completed`。
- 达到 `maxIterations` 时有界结束，`stopReason` 为 `max_iterations`。
- `AbortSignal` 被取消时抛出 `AgentLoopAbortError`。
- 达到 `timeoutMs` 时抛出 `AgentLoopTimeoutError`。
- 工具异常会转换成带 `is_error` 的 `tool_result` 交回模型，使模型可以解释、重试或换用其他方案。
- 模型、observer 或不可恢复的结构错误不会被吞掉；Loop 发送 `loop_error` 后继续向调用方抛出。

## 事件与敏感信息

observer 可收到 `loop_start`、`text`、`stream_fallback`、`llm`、`tool`、`loop_end` 和 `loop_error`。所有事件带有同一 `runId`，迭代相关事件带 `iteration`。

`tool` 事件默认隐藏完整参数和输出。需要展示详情时，应传入 `serializeToolEvent`，只返回经过脱敏的可序列化摘要。`result.toolCalls` 和工作记忆仍保留真实工具结果，调用方不应把它们直接写入日志或长期记忆。

启用 `stream: true` 且客户端实现 `messages.stream()` 时，流对象需要提供异步可迭代的 `textStream` 和 `getFinalMessage()`。流式调用失败会发送 `stream_fallback`，随后自动改用普通调用；取消和超时不会触发降级。
