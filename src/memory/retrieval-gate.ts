import type { AgentMessage, AgentModelClient, AgentObserver } from "../agent-loop/agent-loop.ts";
import type { RetrievalIntent } from "./types.ts";

const GATE_SYSTEM = `你是个人助理记忆检索判定器。Semantic Memory 保存稳定、跨会话有用的用户事实；Session Recall 用于寻找过去对话中的具体事件和过程。
只输出 JSON：{"intent":"none|past_episode|fact_with_evidence","semanticQuery":"Semantic 检索词","sessionRecall":{"mode":"search|recent","query":"search 时的检索词"},"reason":"简短原因"}。
intent 必须遵循：
- none：常识、数学、寒暄或信息完整，不检索记忆；
- past_episode：只需要过去某次对话、事件、操作过程或原始结果，只检索 Session Recall；
- fact_with_evidence：请求涉及稳定偏好、身份、约束、承诺或持续项目事实，同时检索 Semantic Memory 与 Session Recall，以补充来源、变化、例外、冲突、最新状态和具体上下文。
不存在只检索 Semantic Memory 的 intent。任何 Semantic Memory 查询都必须选择 fact_with_evidence，并同时执行 Session Recall；宁可多召回一次历史，也不要漏掉关键信息。拿不准是否需要稳定事实时，也选择 fact_with_evidence。
出现“上次、之前、当时、为什么决定、怎么处理、具体过程、原话、结果”等历史指向，但不需要稳定事实时，选择 past_episode。只有确实需要浏览最近几段历史但没有明确关键词时，Session Recall 才使用 recent；否则使用 search。
检索词生成规则：
- 改写为简短的陈述式关键词，不要照抄问题；去掉“什么、哪一个、是否、怎么、如何、为什么、谁、哪里、何时”等疑问词，以及“吗、呢、请、帮我、告诉我、你记得”等无检索价值的问句成分；
- 删除“用户、我、我的、本人、自己”等主体词，例如“我喜欢喝什么”改为“喜欢 饮品”；
- 保留人名、项目名、产品名、错误码、动作、结果、约束和“上次、昨天、改为”等时间或变化线索；必须保留“不、没、取消、停止”等否定信息；
- 只使用当前消息和 Recent Conversation 中已有的信息，不得猜测答案、补造实体或把 reason 混入检索词；去重并避免宽泛词；
- semanticQuery 聚焦“用户/实体 + 稳定属性或约束”；Session Recall 的 search query 聚焦“事件/动作 + 对象 + 时间或结果线索”。
检索词必须与当前用户消息使用相同语言，不得翻译。`;

type DecisionBase = { reason: string; fallback: boolean };
type SessionRecallDecision = { mode: "search"; query: string } | { mode: "recent" };
export type GateDecision =
  | (DecisionBase & { intent: "none" })
  | (DecisionBase & { intent: "past_episode"; sessionRecall: SessionRecallDecision })
  | (DecisionBase & { intent: "fact_with_evidence"; semanticQuery: string; sessionRecall: SessionRecallDecision });

/** 使用小模型判断单一检索意图；失败时对 Semantic 与 Session Recall 一起 fail-open。 */
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
      model, system: GATE_SYSTEM,
      messages: [{ role: "user", content: `${context ? `Recent Conversation:\n${context}\n\n` : ""}Current Message: ${message}` }],
      tools: [], max_tokens: 800, signal: undefined,
    });
    const text = response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
    const json = extractJson(text);
    const decision = parseDecision(json, message);
    await observer("gate_end", gateEvent(decision));
    return decision;
  } catch (error) {
    const decision: GateDecision = {
      intent: "fact_with_evidence", semanticQuery: message, sessionRecall: { mode: "search", query: message },
      reason: "检索判定失败，对 Semantic Memory 与 Session Recall 执行回退检索", fallback: true,
    };
    await observer("gate_end", { ...gateEvent(decision), errorType: error instanceof Error ? error.name : "UnknownError" });
    return decision;
  }
}

function parseDecision(json: Record<string, unknown>, message: string): GateDecision {
  const intent = retrievalIntent(json.intent);
  const base: DecisionBase = { reason: stringValue(json.reason), fallback: false };
  if (intent === "none") return { ...base, intent };

  const recallValue = objectValue(json.sessionRecall);
  const sessionRecall: SessionRecallDecision = recallValue.mode === "recent"
    ? { mode: "recent" }
    : { mode: "search", query: stringValue(recallValue.query) || message };
  if (intent === "past_episode") return { ...base, intent, sessionRecall };
  return { ...base, intent, semanticQuery: stringValue(json.semanticQuery) || message, sessionRecall };
}

function retrievalIntent(value: unknown): RetrievalIntent {
  if (value === "none" || value === "past_episode" || value === "fact_with_evidence") return value;
  throw new TypeError("检索判定 intent 无效");
}

function gateEvent(decision: GateDecision): Record<string, unknown> {
  const semantic = decision.intent === "fact_with_evidence" ? "retrieve" : "skip";
  const sessionRecallMode = decision.intent === "past_episode" || decision.intent === "fact_with_evidence"
    ? decision.sessionRecall.mode
    : "none";
  return { intent: decision.intent, semantic, sessionRecallMode, reason: decision.reason, fallback: decision.fallback };
}
function extractJson(text: string): Record<string, unknown> {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TypeError("小模型未返回 JSON");
  const value: unknown = JSON.parse(text.slice(start, end + 1));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("检索判定结构无效");
  return value as Record<string, unknown>;
}
function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function stringValue(value: unknown): string { return typeof value === "string" ? value.trim() : "" }
function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((block) => block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => String((block as { text?: unknown }).text ?? "")).join("");
}
