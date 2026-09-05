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
        tokenUsage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
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

可选的 `modelContextWindow` 与同步 `TokenEstimator` 会在每次模型调用前估算 System Prompt、完整 messages 和工具 schema。估算输入、`maxTokens` 与固定 512-token 安全余量之和超过窗口时，Loop 明确失败，不会静默裁剪历史或工具结果。估算不承诺与任一供应商的分词结果完全一致，也不会调用远程计数接口。

## 结束条件与事件

- 模型不再请求工具时，`stopReason` 为 `completed`。
- 达到 `maxIterations` 时，`stopReason` 为 `max_iterations`。
- 取消或超时时分别抛出 `AgentLoopAbortError` 和 `AgentLoopTimeoutError`。
- 工具异常会转换成带 `is_error` 的 `tool_result` 交回模型。
- 模型、observer 或响应结构错误会在发送 `loop_error` 后继续向调用方抛出。

observer 会收到 `context_assembled`、`loop_start`、`model_request`、`model_response`、`model_failed`、`text`、`stream_fallback`、`tool_started`、`tool_completed`、`tool_failed`、`reply`、`loop_end` 和 `loop_error` 等事件。`model_request` 保存该迭代实际使用的 System Prompt、messages、工具 schema 和生成参数快照；`model_response` 保存完整的标准化响应，并通过 `tokenUsage` 记录供应商返回的真实输入、输出与总 token 数。供应商缺失或返回不完整 usage 时该字段为 `null`，不会用估算值补齐。所有事件带同一 `runId`，迭代相关事件带 `iteration`，模型与工具事件分别通过 `modelCallId` 与 `toolCallId` 关联。调用方可传入 `runId` 与持久 Session 对齐；省略时由 Loop 生成 UUID。

工具事件默认包含完整参数和输出；涉及凭证的调用方必须通过 `serializeToolEvent` 移除 API Key、令牌、Cookie 等字段。启用 `stream: true` 且客户端实现 `messages.stream()` 时，流式调用失败会降级到普通调用；取消和超时不会触发降级。

## 安全边界

- Agent 回合同时受到迭代上限、整轮超时和客户端取消信号约束。
- Loop 不记录模型密钥。工具参数和输出会进入 observer；持久化或向外发送前由调用方移除凭证字段。
- 外部写操作的确认和审计策略由注入的工具注册表执行。

## 与 Agent Runtime 的关系

`src/agent-runtime/` 组合真实模型、Memory、工具和 Tracer，并管理回合前后的检索、持久化与会话锁。本模块保持模型与工具无关，不读取本地配置文件，也不承担 Web 请求或资源初始化。集成入口见 [Agent Runtime](../agent-runtime/README.md)。
