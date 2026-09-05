import { fileURLToPath, URL } from "node:url";
import { agentHarnessGraph, createAgentRuntime } from "../../src/index.ts";
import type { AgentObserver, AgentSettingsInput, AgentProvider, RetrievalMode } from "../../src/index.ts";
export { AgentConfigError } from "../../src/index.ts";

const runtime = createAgentRuntime({
  home: fileURLToPath(new URL("../../.everything/", import.meta.url)),
  envPath: fileURLToPath(new URL("../../.env", import.meta.url)),
  defaultSystemPromptPath: fileURLToPath(new URL("../../EVERYTHING.md", import.meta.url)),
});
export const { clearEmbeddingApiKey,
  resetRuntimeSettings, rebuildEmbeddingIndex, cancelEmbeddingIndexRebuild,
} = runtime;

/** 组装 Web 首屏数据；静态拓扑来自 Graph.describe()。 */
export async function loadAgentBootstrap(): Promise<Record<string, unknown>> {
  await runtime.start();
  return { workflow: toWorkflow(), settings: await runtime.getSettings(),
    systemPrompt: await runtime.readSystemPrompt(), sessions: runtime.memory.listSessions() };
}
/** 校验 Web 输入并将事件交给传输层。 */
export function runLocalAgent(body: Record<string, unknown>, observer: AgentObserver, signal: AbortSignal) {
  return runtime.run({ prompt: requiredText(body.prompt, "User Prompt", 40_000),
    sessionId: requiredText(body.sessionId, "Session ID", 200) }, { observer, signal });
}
/** Web 清理入口要求显式确认；运行互斥与资源清理由 Runtime 管理。 */
export function clearLocalAgentData(body: Record<string, unknown>) {
  if (body.confirmation !== "DELETE_ALL_LOCAL_DATA") throw new TypeError("缺少清理确认");
  return runtime.clearLocalAgentData();
}
/** Session、Memory 与 trace 页面共用的本地只读/写入操作。 */
export async function handleMemoryAction(body: Record<string, unknown>): Promise<unknown> {
  const memory = runtime.memory;
  const action = requiredText(body.action, "action", 80);
  if (action === "bootstrap") return memoryDashboard(memory);
  if (action === "create_session") {
    const previousSessionId = optionalText(body.previousSessionId, "Previous Session ID", 200);
    const session = runtime.createSession(previousSessionId);
    return { session, sessions: memory.listSessions() };
  }
  if (action === "ensure_session") {
    const session = memory.ensureSession();
    return { session, sessions: memory.listSessions() };
  }
  if (action === "select_session") {
    const sessionId = requiredText(body.sessionId, "Session ID", 200);
    return { messages: memory.getChatLog(sessionId), sessions: memory.listSessions() };
  }
  if (action === "rename_session") return memory.renameSession(requiredText(body.sessionId, "Session ID", 200), requiredText(body.title, "标题", 120));
  if (action === "delete_session") {
    memory.deleteSession(requiredText(body.sessionId, "Session ID", 200));
    return { sessions: memory.listSessions() };
  }
  if (["create_semantic", "search_semantic", "update_semantic", "delete_semantic", "session_search", "session_read"].includes(action)) {
    await runtime.prepareMemory();
  }
  if (action === "create_semantic") return memory.createSemantic(requiredText(body.subject, "Subject", 500), requiredText(body.content, "Content", 20_000), "ui");
  if (action === "search_semantic") return memory.searchSemantic(requiredText(body.query, "Query", 2_000), 100);
  if (action === "update_semantic") return memory.updateSemantic(positiveId(body.id), requiredText(body.subject, "Subject", 500), requiredText(body.content, "Content", 20_000), "ui");
  if (action === "delete_semantic") return void memory.deleteSemantic(positiveId(body.id), "ui");
  if (action === "session_search") {
    const recall = await runtime.prepareMemory();
    return memory.searchSessions({
      query: body.query === undefined ? undefined : requiredText(body.query, "Query", 2_000),
      recent: body.recent === true,
      limit: body.limit === undefined ? undefined : Number(body.limit),
      window: body.window === undefined ? undefined : Number(body.window),
    }, recall);
  }
  if (action === "session_read") {
    const recall = await runtime.prepareMemory();
    return memory.readSession({
      sessionId: body.sessionId === undefined ? undefined : requiredText(body.sessionId, "Session ID", 200),
      cursor: body.cursor === undefined ? undefined : requiredText(body.cursor, "Cursor", 10_000),
    }, recall);
  }
  throw new TypeError("未知 Memory action");
}

function toWorkflow(): Record<string, unknown> {
  const description = agentHarnessGraph.describe();
  return {
    name: description.name,
    nodes: description.nodes.map((node) => ({
      id: node.name,
      label: node.name,
      kind: node.kind,
      maxVisits: node.maxVisits,
    })),
    edges: description.edges,
  };
}

function memoryDashboard(memory: typeof runtime.memory): Record<string, unknown> {
  return {
    overview: memory.overview(),
    sessions: memory.listSessions(),
    semantic: memory.listSemantic(),
    chatLog: memory.getChatLog(undefined, 2_000),
    consolidations: memory.listConsolidations(),
  };
}

function positiveId(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError("ID 必须是正整数");
  return number;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const text = optionalText(value, field, maxLength);
  if (!text.trim()) throw new TypeError(`${field} 不能为空`);
  return text;
}

function optionalText(value: unknown, field: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maxLength) {
    throw new TypeError(`${field} 必须是小于 ${maxLength} 字符的字符串`);
  }
  return value.trim();
}


/** 将请求中的未知配置字段转换为 Runtime 的类型化输入。 */
export function saveAgentSettings(body: Record<string, unknown>) {
  const provider = providerInput(body.provider);
  const input: AgentSettingsInput = { provider, model: requiredText(body.model, "Model", 200) };
  for (const key of ["smallModel", "baseUrl", "apiKey", "embeddingApiKey", "embeddingBaseUrl", "embeddingModel", "embeddingQueryTemplate", "embeddingDocumentTemplate"] as const) {
    if (body[key] !== undefined) input[key] = optionalText(body[key], key, 10_000);
  }
  for (const key of ["sessionSearchWindow", "sessionScrollStep", "sessionRecallMessageLimit", "sessionRecallTokenLimit", "modelContextWindow", "embeddingMinimumSimilarity"] as const) {
    if (body[key] !== undefined && body[key] !== "") input[key] = Number(body[key]);
  }
  if (body.retrievalMode !== undefined) {
    if (!["lexical_only", "dense_only", "hybrid"].includes(String(body.retrievalMode))) throw new TypeError("Retrieval Mode 无效");
    input.retrievalMode = body.retrievalMode as RetrievalMode;
  }
  input.clearApiKey = body.clearApiKey === true;
  input.clearEmbeddingApiKey = body.clearEmbeddingApiKey === true;
  input.force = body.force === true;
  return runtime.saveAgentSettings(input);
}
/** 解析提供方后清除对应密钥。 */
export function clearProviderApiKey(body: Record<string, unknown>) {
  return runtime.clearProviderApiKey(providerInput(body.provider));
}
/** 校验页面输入后保存规则。 */
export function saveSystemPrompt(body: Record<string, unknown>) {
  return runtime.saveSystemPrompt(requiredText(body.systemPrompt, "System Prompt", 100_000));
}
function providerInput(value: unknown): AgentProvider {
  if (value !== "anthropic" && value !== "openai-compatible") throw new TypeError("Provider 必须是 anthropic 或 openai-compatible");
  return value;
}

/** 组装 trace 页面的文件列表。 */
export async function loadTraceDashboard() {
  return { files: await runtime.readTraces() };
}
