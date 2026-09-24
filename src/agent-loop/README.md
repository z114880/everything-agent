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

可选的 `modelContextWindow` 与同步 `TokenEstimator` 会在每次主模型调用前估算 System Prompt、当前工作 messages 和工具 schema。可用输入额度为 `modelContextWindow - maxTokens - 512`；输入达到额度的 70% 时自动 compact，目标是将总输入降至额度的 30% 左右。30% 是软目标：系统提示、工具定义、当前用户请求和最近完整交互优先保留，不为满足比例截断它们。

compact 使用同一主模型、关闭工具和流式输出，将旧摘要与较早历史合并为一份工作摘要；大段历史按摘要请求实际额度分批读取，最多 32 批，受本轮统一取消与截止时间保护。工具调用及结果成组保留。无法压缩的上下文不会反复调用摘要；普通压缩失败后本轮不重试，仍在硬限制内则继续，否则明确失败。空摘要、工具调用、输出截断或未减少输入都视为失败。估算不承诺与任一供应商的分词结果完全一致。

传入的 `messages` 仍只追加原始模型回复与工具结果，不被压缩替换。可选同步 `onCompacted(checkpoint)` 在切换工作上下文前原子保存检查点；回调抛错时保留原上下文，取消、超时或晚到响应不会提交。检查点包含新的 `messages`、压缩身份和前后水位；Loop 不直接依赖数据库。

## 结束条件与事件

返回结果除 `reply`、`toolCalls`、`iterations` 和 `stopReason` 外，还带回本轮的执行统计：`modelMs`（含摘要调用）与 `toolMs` 分别累计模型调用和工具调用的耗时（两者顺序执行，之和不超过整轮耗时），`failedToolCallCount` 是返回错误结果的工具调用数量，`peakEstimatedInputTokens` 是各次迭代请求估算输入 token 的最大值（未注入 `tokenEstimator` 时为 `null`），`peakInputTokens` 是供应商返回的真实输入 token 峰值（没有任何一次调用报告 usage 时为 `null`）。估算峰值与 Context Window 硬限制同口径，超限的那次请求同样计入峰值。

- 模型不再请求工具时，`stopReason` 为 `completed`。
- 达到 `maxIterations` 时，`stopReason` 为 `max_iterations`。
- 取消或超时时分别抛出 `AgentLoopAbortError` 和 `AgentLoopTimeoutError`。
- 工具异常会转换成带 `is_error` 的 `tool_result` 交回模型。
- 模型、observer 或响应结构错误会在发送 `loop_error` 后继续向调用方抛出。

observer 会收到 `context_assembled`、`loop_start`、`model_request`、`model_response`、`model_failed`、`text`、`stream_fallback`、`tool_started`、`tool_completed`、`tool_failed`、`reply`、`loop_end` 和 `loop_error` 等事件。`model_request` 保存该迭代实际使用的 System Prompt、messages、工具 schema 和生成参数快照；`model_response` 保存完整的标准化响应，并通过 `tokenUsage` 记录供应商返回的真实输入、输出与总 token 数。供应商缺失或返回不完整 usage 时该字段为 `null`，不会用估算值补齐。`loop_end` 除结束原因外同时带上述执行统计，调用方无需自行聚合逐次事件。所有事件带同一 `turnId`，迭代相关事件带 `iteration`，模型与工具事件分别通过 `modelCallId` 与 `toolCallId` 关联。调用方可传入 `turnId` 与持久 Session 对齐；省略时由 Loop 生成 UUID。

工具事件默认包含完整参数和输出；涉及凭证的调用方必须通过 `serializeToolEvent` 移除 API Key、令牌、Cookie 等字段。启用 `stream: true` 且客户端实现 `messages.stream()` 时，流式调用失败会降级到普通调用；取消和超时不会触发降级。

## 安全边界

- Agent 回合同时受到迭代上限、整轮超时和客户端取消信号约束。
- Loop 不记录模型密钥。工具参数和输出会进入 observer；持久化或向外发送前由调用方移除凭证字段。
- 外部写操作的确认和审计策略由注入的工具注册表执行。

## 与 Agent Runtime 的关系

`src/agent-runtime/` 组合真实模型、Memory、工具和 Tracer，并管理回合前后的检索、持久化与会话锁。本模块保持模型与工具无关，不读取本地配置文件，也不承担 Web 请求或资源初始化。集成入口见 [Agent Runtime](../agent-runtime/README.md)。

工具内部 observer 事件统一携带本次 `toolCallId` 和 `iteration`，可关联到实际工具步骤。事件顺序仍以 observer 为准。

### 供应商续接数据

模型内容块可携带 `providerMetadata`，Loop 不解析并在下一轮原样保留，由模型适配器用于协议续接。Gemini 适配器通过它保留原始 Part（包括 thought signature 与 function call ID），思考或签名专用块使用 `provider_content`，不作为聊天文本或工具执行。既有 `model_response` 和 `model_request` 事件仍承载完整标准化响应与请求；Gemini 用量统一计入供应商报告的输入、候选输出及思考 token，不新增估算消耗事件。

### Compact 事件

- `compact_started`：`compactionId`、`iteration`、`beforeTokens`、`targetTokens`、`availableInputTokens`。
- `compact_model_started/completed/failed`：同一压缩身份，以及 `modelCallId`、`batchIndex`、`model`；完成带真实 `tokenUsage` 和 `ms`，失败带 `errorType` 和 `ms`。
- `compact_completed`：原子保存成功后产生，增加 `afterTokens`、`targetReached`、`ms`；随后才发送带本次 `compactionId` 的主任务 `model_request`。
- `compact_failed`：保留原上下文，带 `errorType`、固定 `reasonCode`（模型失败、无额度、批次上限、无效摘要、无压缩收益、保存失败或中断）、`ms`；取消和超时仍会终止回合。

事件不包含摘要或历史正文；主任务实际模型请求沿用现有内容记录策略。`peakEstimatedInputTokens` 保留压缩前达到的峰值，不能当作压缩后当前水位；摘要请求用量通过独立事件报告。
