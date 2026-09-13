import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** 本回合模型应当产生的行为：先发起工具调用，再给出最终回复。 */
export interface TurnScript {
  toolCalls?: Array<{ name: string; input: unknown }>;
  reply: string;
}

/** 由调用方按当前用户消息决定本回合脚本；返回 undefined 时使用通用回复。 */
export interface FakeProviderOptions {
  plan?: (prompt: string) => TurnScript | undefined;
}

export interface FakeProviderStats {
  gate: number;
  agent: number;
  memoryDecision: number;
  consolidation: number;
  embedding: number;
}

export interface FakeProvider {
  /** 供 EVERYTHING_*_BASE_URL 使用的本地地址。 */
  baseUrl: string;
  stats: FakeProviderStats;
  /** 切换当前生效的回合脚本，用于在同一服务上依次写入多个数据集。 */
  setPlan(plan: (prompt: string) => TurnScript | undefined): void;
  close(): Promise<void>;
}

const VECTOR_DIMENSIONS = 1024;
const CATEGORIES = ["user_attribute", "preference", "ongoing_project", "constraint", "commitment"] as const;

/**
 * 启动一个 OpenAI 兼容的本地假供应商，覆盖 /chat/completions、/embeddings 与 /models。
 * 它按 system prompt 的特征区分 Gate、主模型、记忆决策与 consolidation 四类请求，
 * 使真实 Agent Runtime 无需任何改动即可产生完整数据，且不发生任何外部网络调用。
 */
export async function startFakeProvider(options: FakeProviderOptions = {}): Promise<FakeProvider> {
  const stats: FakeProviderStats = { gate: 0, agent: 0, memoryDecision: 0, consolidation: 0, embedding: 0 };
  const state: FakeProviderOptions = { ...options };
  const server: Server = createServer((request, response) => {
    handle(request, response, state, stats).catch((error: unknown) => {
      respondJson(response, 500, { error: { message: error instanceof Error ? error.message : String(error) } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stats,
    setPlan(plan) { state.plan = plan },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: FakeProviderOptions,
  stats: FakeProviderStats,
): Promise<void> {
  const url = request.url ?? "";
  if (request.method === "GET" && url.endsWith("/models")) {
    return respondJson(response, 200, { data: [{ id: "fake-agent" }, { id: "fake-small" }, { id: "fake-embedding" }] });
  }
  const body = await readJson(request);
  if (url.endsWith("/embeddings")) {
    stats.embedding += 1;
    const input = Array.isArray(body.input) ? body.input as string[] : [String(body.input ?? "")];
    return respondJson(response, 200, {
      data: input.map((text, index) => ({ index, embedding: deterministicVector(text) })),
      usage: { prompt_tokens: input.length * 8, total_tokens: input.length * 8 },
    });
  }
  if (!url.endsWith("/chat/completions")) return respondJson(response, 404, { error: { message: `未知路径：${url}` } });

  const messages = (body.messages ?? []) as Array<Record<string, unknown>>;
  const system = String(messages.find((item) => item.role === "system")?.content ?? "");
  const reply = planReply(system, messages, options, stats);
  if (body.stream === true) return respondStream(response, reply);
  return respondJson(response, 200, {
    choices: [{
      index: 0,
      message: {
        content: reply.text || null,
        ...(reply.toolCalls.length ? {
          tool_calls: reply.toolCalls.map((call) => ({
            id: call.id, type: "function", function: { name: call.name, arguments: call.arguments },
          })),
        } : {}),
      },
      finish_reason: reply.toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
  });
}

interface PlannedReply { text: string; toolCalls: Array<{ id: string; name: string; arguments: string }> }

function planReply(
  system: string,
  messages: Array<Record<string, unknown>>,
  options: FakeProviderOptions,
  stats: FakeProviderStats,
): PlannedReply {
  if (system.includes('只输出 JSON：{"intent"')) {
    stats.gate += 1;
    return { text: gateDecision(lastUserPrompt(messages)), toolCalls: [] };
  }
  if (system.includes("记忆管理模型")) {
    stats.memoryDecision += 1;
    return { text: memoryDecision(messages), toolCalls: [] };
  }
  if (system.includes("Semantic Memory 整理模型")) {
    stats.consolidation += 1;
    // decisions 与 unresolvedConflicts 都为空时，校验只接受 no_change。
    return { text: JSON.stringify({ decisions: [], unresolvedConflicts: [], outcome: { action: "noop", reasonCode: "no_change" } }), toolCalls: [] };
  }
  stats.agent += 1;
  const lastUserIndex = lastUserIndexOf(messages);
  const prompt = lastUserIndex < 0 ? "" : String(messages[lastUserIndex]!.content ?? "");
  const script = options.plan?.(prompt);
  // 只看当前回合：Working Memory 会带入历史轮的 tool 消息，用整个上下文判断会让
  // 第一轮之后的所有回合都跳过工具调用。
  const toolRoundDone = messages.slice(lastUserIndex + 1).some((item) => item.role === "tool");
  if (!toolRoundDone && script?.toolCalls?.length) {
    return {
      text: "",
      toolCalls: script.toolCalls.map((call, index) => ({
        id: `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
        name: call.name,
        arguments: JSON.stringify(call.input ?? {}),
      })),
    };
  }
  return { text: script?.reply ?? `已经记下这件事：${prompt.slice(0, 40)}。需要我继续跟进吗？`, toolCalls: [] };
}

/** Gate 判定保持召回率优先：带指代或回顾意味的问题走 past_episode，其余走 fact_with_evidence。 */
function gateDecision(prompt: string): string {
  if (/上次|之前|还记得|当时|以前|那次/.test(prompt)) {
    return JSON.stringify({
      intent: "past_episode",
      sessionRecall: { mode: "search", query: prompt.slice(0, 30) },
      reason: "用户在回顾历史对话",
    });
  }
  if (/^(你好|谢谢|辛苦|收到)/.test(prompt)) {
    return JSON.stringify({ intent: "none", reason: "寒暄不需要检索" });
  }
  return JSON.stringify({
    intent: "fact_with_evidence",
    denseQuery: prompt.slice(0, 40),
    lexicalQuery: prompt.slice(0, 20),
    sessionRecall: { mode: "search", query: prompt.slice(0, 30) },
    reason: "需要稳定事实并核对历史",
  });
}

/** 记忆决策必须引用候选自带的证据 ID，否则真实校验会拒绝写入。 */
function memoryDecision(messages: Array<Record<string, unknown>>): string {
  const payload = parsePayload(String(messages.find((item) => item.role === "user")?.content ?? "{}"));
  const candidate = payload.candidate as Record<string, unknown> | undefined;
  const evidence = Array.isArray(candidate?.evidenceMessageIds) ? candidate.evidenceMessageIds as number[] : [];
  const subject = String(candidate?.subject ?? "用户");
  const content = String(candidate?.content ?? "");
  if (!evidence.length || !content) {
    return JSON.stringify({ action: "noop", reason: "证据不足", reasonCode: "uncertain", evidenceMessageIds: evidence.length ? evidence : [1] });
  }
  if (candidate?.intent === "forget") {
    const facts = Array.isArray(payload.relatedFacts) ? payload.relatedFacts as Array<Record<string, unknown>> : [];
    const target = facts[0]?.id;
    if (typeof target !== "number") {
      return JSON.stringify({ action: "noop", reason: "没有匹配的目标事实", reasonCode: "uncertain", evidenceMessageIds: evidence });
    }
    return JSON.stringify({ action: "delete", reason: "用户明确要求忘记", reasonCode: "explicit_forget", evidenceMessageIds: evidence, targetId: target });
  }
  return JSON.stringify({
    action: "create", reason: "用户陈述了新的稳定事实", reasonCode: "new_fact",
    evidenceMessageIds: evidence, subject, content,
    category: categoryFor(String(candidate?.attribute ?? "")), stable: true, futureUseful: true,
  });
}

function categoryFor(attribute: string): string {
  if (/偏好|喜欢|口味/.test(attribute)) return "preference";
  if (/项目|计划|进展/.test(attribute)) return "ongoing_project";
  if (/过敏|限制|预算|禁止/.test(attribute)) return "constraint";
  if (/约定|承诺|截止/.test(attribute)) return "commitment";
  return CATEGORIES[0];
}

function parsePayload(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {} }
}

function lastUserPrompt(messages: Array<Record<string, unknown>>): string {
  const index = lastUserIndexOf(messages);
  return index < 0 ? "" : String(messages[index]!.content ?? "");
}

/** 当前回合的用户消息位置：从后往前第一条 content 为字符串的 user 消息。 */
function lastUserIndexOf(messages: Array<Record<string, unknown>>): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && typeof message.content === "string") return index;
  }
  return -1;
}

function respondStream(response: ServerResponse, reply: PlannedReply): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const send = (value: unknown) => response.write(`data: ${JSON.stringify(value)}\n\n`);
  for (const chunk of splitText(reply.text)) {
    send({ choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] });
  }
  reply.toolCalls.forEach((call, index) => {
    send({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, id: call.id, function: { name: call.name, arguments: call.arguments } }] },
        finish_reason: null,
      }],
    });
  });
  send({
    choices: [{ index: 0, delta: {}, finish_reason: reply.toolCalls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 128, completion_tokens: 64, total_tokens: 192 },
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function splitText(text: string): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += 12) chunks.push(text.slice(index, index + 12));
  return chunks;
}

/**
 * 确定性词袋向量：共享词越多的文本向量越接近，使 Dense 检索结果稳定可复现。
 * 它不表达真实语义，只保证同一文本每次得到同一向量。
 */
function deterministicVector(text: string): number[] {
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  const tokens = text.toLowerCase().match(/[一-龥]|[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    for (let repeat = 0; repeat < 4; repeat += 1) {
      hash = Math.imul(hash ^ (hash >>> 13), 16777619);
      const slot = Math.abs(hash) % VECTOR_DIMENSIONS;
      vector[slot] = (vector[slot] ?? 0) + 1;
    }
  }
  if (!tokens.length) vector[0] = 1;
  return vector;
}

function respondJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (!chunks.length) return {};
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
