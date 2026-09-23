# 模型协议适配

通过 `createModelClient(config)` 创建供 Agent Loop、检索判断和记忆任务使用的模型客户端。入口为 `src/model/model-client.ts`，也由包的 `src/index.ts` 导出。协议适配不依赖 UI、数据库或工具实现。

## 支持的协议

| Provider | 默认 Base URL | API Key 认证 | 请求接口 |
| --- | --- | --- | --- |
| `anthropic` | `https://api.anthropic.com` | `x-api-key` | `/v1/messages` |
| `openai-compatible` | `https://api.openai.com/v1` | `Authorization: Bearer …` | `/chat/completions` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta` | `x-goog-api-key` | `/models/{model}:generateContent` / `:streamGenerateContent?alt=sse` |

三种协议均提供 `messages.create(request)` 和 `messages.stream(request)`。请求使用统一的 `ModelRequest`，响应归一化为 `ModelResponse`。工具定义仍使用 `input_schema`，工具调用与结果使用 `tool_use` / `tool_result`。HTTP 错误和供应商错误向调用方抛出，取消信号传入 fetch；Agent Loop 负责整轮超时、迭代限制和流式失败降级。

## Google Gemini

在配置页为 Agent Model / Small Model 选择 **Google Gemini**，填写服务提供的模型 ID 和 API Key。Base URL 可留空，也可填写包含 API 版本的代理基础地址，不要追加 `/models` 或方法名。模型 ID 支持带或不带 `models/` 前缀。

原生适配实现：

- 系统提示映射到 `systemInstruction`，对话映射到 `contents`，助理角色转换为 `model`。
- 工具使用 `functionDeclarations` 与 `parametersJsonSchema`；结果通过 `functionResponse` 返回，并按照调用 ID 匹配函数名。供应商未返回调用 ID 时，仅为本地执行生成 ID，不伪造供应商 ID。
- Gemini 返回的 Part 保存在 `providerMetadata.gemini`，多轮对话与工具续接原样回传，包括 `thoughtSignature`、调用 ID 和 Part 顺序。思考内容不进入聊天文本增量；签名可能位于空文本 Part，不能丢弃。
- SSE 完整读取后才产生最终响应，支持文本增量与多工具调用。被拦截、工具调用格式错误、空响应或未收到结束原因就断流时抛出错误；`MAX_TOKENS` 保留已生成内容及停止原因，不自动续写。
- `tokenUsage.inputTokens` 对应 `promptTokenCount`，`outputTokens` 为 `candidatesTokenCount + thoughtsTokenCount`；优先采用供应商的 `totalTokenCount`，未给出总数时用有效分项相加。输入或候选输出用量不完整时返回 `null`，不估算实际消耗。

当前支持文本与本地注册工具，不启用 Gemini 内置搜索、代码执行、图片或音视频能力。认证仅覆盖 Gemini Developer API 的 API Key，不支持 Vertex AI OAuth。Embedding 使用独立的 Provider 配置，支持 OpenAI Compatible 与 Google Gemini，详见 [向量协议文档](../memory/retrieve/README.md#embedding-协议与配置)。

密钥由本地 Runtime 读取并注入客户端，不写入模型请求正文；配置与本地存储边界见 [Runtime 文档](../agent-runtime/README.md#本地配置)。

实现依据：[GenerateContent API](https://ai.google.dev/api/generate-content)、[模型列表](https://ai.google.dev/api/models)、[Thought signatures](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)。

## 验证

测试位于 `test/`，通过公开客户端和 Runtime 验证请求转换、流式分片、工具续接、签名保存、错误、用量和本地配置，不需要真实 API Key。

```bash
pnpm exec vitest run src/model/test src/agent-runtime/test/gemini-config.test.ts web/test/gemini-config.test.tsx
```
