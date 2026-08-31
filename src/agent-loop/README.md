# Agent Loop

`src/agent-loop/` 提供模型与工具无关的 `observe → reason → act → repeat` 回合循环。模型客户端和工具注册表通过小接口注入，Loop 不直接初始化模型、数据库或 UI。

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

工具注册表公开 schema 和受控执行入口：

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

工具执行上下文还包含 `deadline`、`iteration` 和 `toolUseId`。工具注册表负责名称查找、参数校验、读写权限、外部写操作确认和审计；模型只能请求注册过的工具。

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

传入的 `messages` 会原地追加模型响应和工具结果，使下一次推理可以观察本轮已执行的动作。

## 结束条件与事件

- 模型不再请求工具时，`stopReason` 为 `completed`。
- 达到 `maxIterations` 时，`stopReason` 为 `max_iterations`。
- 取消或超时时分别抛出 `AgentLoopAbortError` 和 `AgentLoopTimeoutError`。
- 工具异常会转换成带 `is_error` 的 `tool_result` 交回模型。
- 模型、observer 或响应结构错误会在发送 `loop_error` 后继续向调用方抛出。

observer 会收到 `working_memory`、`loop_start`、`llm_start`、`llm_end`、`text`、`stream_fallback`、`tool_start`、`tool_end`、`reply`、`loop_end` 和 `loop_error` 等事件。所有事件带同一 `runId`，迭代相关事件带 `iteration`。

工具事件默认隐藏完整参数和输出。需要展示详情时，应通过 `serializeToolEvent` 只返回脱敏摘要。启用 `stream: true` 且客户端实现 `messages.stream()` 时，流式调用失败会降级到普通调用；取消和超时不会触发降级。

## 安全边界

- Agent 回合同时受到迭代上限、整轮超时和客户端取消信号约束。
- Loop 不记录模型密钥，也不默认暴露完整工具参数和输出。
- 外部写操作的确认和审计策略由注入的工具注册表执行。
