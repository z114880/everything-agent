import type { AgentMessage, AgentModelClient, AgentObserver } from "../agent-loop/agent-loop.ts";

const GATE_SYSTEM = `你是个人助理长期记忆的检索判定器。判断当前消息是否需要用户的长期记忆才能更好回答。
只输出 JSON：{"retrieve":true或false,"query":"检索词","reason":"简短原因"}。
常识、数学、寒暄和信息完整的请求通常不需要；涉及用户的生活、人物、偏好、项目、计划或过去事件时需要。
检索词必须与当前用户消息使用相同语言，不得翻译。`;

export interface GateDecision {
  retrieve: boolean;
  query: string;
  reason: string;
  fallback: boolean;
}

/** 使用小模型判断是否检索；任何失败都回退为执行本地检索。 */
export async function decideRetrieval(
  client: AgentModelClient,
  model: string,
  message: string,
  history: AgentMessage[],
  observer: AgentObserver = () => {},
): Promise<GateDecision> {
  await observer("gate_start", {});
  try {
    const context = history.map((item) => `${item.role}: ${plainText(item.content)}`).join("\n");
    const response = await client.messages.create({
      model,
      system: GATE_SYSTEM,
      messages: [{ role: "user", content: `${context ? `Recent Conversation:\n${context}\n\n` : ""}Current Message: ${message}` }],
      tools: [],
      max_tokens: 600,
      signal: undefined,
    });
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    const json = extractJson(text);
    const decision: GateDecision = {
      retrieve: json.retrieve === true,
      query: typeof json.query === "string" && json.query.trim() ? json.query.trim() : message,
      reason: typeof json.reason === "string" ? json.reason : "",
      fallback: false,
    };
    await observer("gate_end", { decision: decision.retrieve ? "retrieve" : "skip", reason: decision.reason, fallback: false });
    return decision;
  } catch (error) {
    const decision: GateDecision = {
      retrieve: true,
      query: message,
      reason: "检索判定失败，已执行回退检索",
      fallback: true,
    };
    await observer("gate_end", {
      decision: "retrieve",
      reason: decision.reason,
      fallback: true,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return decision;
  }
}

function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TypeError("小模型未返回 JSON");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("检索判定结构无效");
  return value as Record<string, unknown>;
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? "")).join("");
}
