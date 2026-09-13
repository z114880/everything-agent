import type { Workflow } from "./workflow-api";

export type AgentProvider = "anthropic" | "openai-compatible";
export type RetrievalMode = "lexical_only" | "dense_only" | "hybrid";

export interface ModelConnectionSettings {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

export interface AgentSettings {
  agentModel: ModelConnectionSettings;
  smallModel: ModelConnectionSettings;
  sessionSearchWindow: number;
  sessionRecallMessageLimit: number;
  sessionRecallTokenLimit: number;
  modelContextWindow: number;
  maxTokens: number;
  maxIterations: number;
  retrievalMode: RetrievalMode;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingQueryTemplate: string;
  embeddingDocumentTemplate: string;
  embeddingMinimumSimilarity: number;
  embeddingKeyConfigured: boolean;
  embeddingKeyLast4: string;
  embeddingIndex: { ready: boolean; generationId: string | null; profileHash: string | null };
  limits: Record<string, { min: number; max: number }>;
}

export interface AgentBootstrap {
  workflow: Workflow;
  settings: AgentSettings;
  systemPrompt: string;
  sessions: SessionSummary[];
  semanticCount: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;

  completedRunCount: number;
  incompleteRunCount: number;
}

export interface ChatLogEntry {
  id: number;
  sessionId: string;
  runId: string;
  role: string;
  kind: string;
  content: unknown;
  createdAt: string;
  runComplete?: boolean;
  contentTruncated?: boolean;
  contentFragment?: boolean;
  contentOffset?: number;
}

export interface SessionRecallResult {
  session: SessionSummary;
  rank: number;
  retrievalSignals: { bm25?: number; dense?: number; fused?: number; mmr?: number };
  match: null | { messageId: number; bm25?: number; dense?: number; totalMatches: number };
  entries: ChatLogEntry[];
  totalMessageCount: number;
  returnedMessageCount: number;
  indexedMessageCount: number;
  returnedRanges: Array<{ fromMessageId: number; toMessageId: number }>;
  isComplete: boolean;
  truncated: boolean;
  nextCursor: string | null;
}
export interface SessionSearchResult {
  retrievalMode: "search" | "recent";
  query?: string;
  requestedLimit: number;
  returnedSessionCount: number;
  droppedSessionCount: number;
  truncated: boolean;
  sessions: SessionRecallResult[];
}
export interface SessionReadResult {
  session: SessionSummary;
  entries: ChatLogEntry[];
  totalMessageCount: number;
  returnedMessageCount: number;
  returnedRanges: Array<{ fromMessageId: number; toMessageId: number }>;
  isComplete: boolean;
  truncated: boolean;
  nextCursor: string | null;
}

export interface SemanticMemory {
  id: number; subject: string; content: string; source: string; createdAt: string; updatedAt: string;
}

export interface ConsolidationRun {
  id: number; runId: string; trigger: string; status: string; totalBatches: number; completedBatches: number; unresolvedConflicts: number;
  factsCreated: number; factsUpdated: number; factsSkipped: number; factsDeleted: number; factsMerged: number;
  errorType: string | null; startedAt: string; completedAt: string | null;
}

export interface MemoryDashboard {
  overview: { semanticCount: number; indexedSessionCount: number; indexedMessageCount: number; sessionCount: number; databasePath: string; latestConsolidation: ConsolidationRun | null };
  sessions: SessionSummary[];
  semantic: SemanticMemory[];
  chatLog: ChatLogEntry[];
  consolidations: ConsolidationRun[];
}

export interface TraceRecord {
  version: number; eventId?: string; type: string; timestamp: string; sequence?: number; runId: string; sessionId?: string;
  iteration?: number; modelCallId?: string; toolCallId?: string; payload?: Record<string, unknown>; [key: string]: unknown;
}

export interface TraceFile {
  path: string;
  records: TraceRecord[];
}

export interface TraceDashboard {
  files: TraceFile[];
}

export interface AgentSkill {
  name: string;
  description: string;
  instructions: string;
  path: string;
}

export interface AgentTool {
  name: string;
  description: string;
  origin: "内置" | "Tavily";
  enabled: boolean;
  configurable: boolean;
  configured: boolean;
  configurationLabel?: string;
}

export interface ToolsCatalog {
  tools: AgentTool[];
  tavily: { keyConfigured: boolean; keyLast4: string };
}

export interface DatabaseColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: unknown;
}

export interface DatabaseTable {
  name: string;
  count: number;
  columns: DatabaseColumn[];
  rows: unknown[][];
}

export interface DatabaseDashboard {
  path: string;
  size: number;
  tables: DatabaseTable[];
}

export interface DatabaseQueryResult {
  kind: "read" | "write";
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  changes: number;
  lastInsertRowid: number | string | null;
}

export interface ClientHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentEvent {
  completedBatches?: number;
  totalBatches?: number;
  taskKind?: string;
  taskId?: string;
  intent?: "none" | "past_episode" | "fact_with_evidence";
  runId?: string;
  iteration?: number;
  delta?: string;
  tool?: string;
  toolUseId?: string;
  toolCallId?: string;
  summary?: string;
  args?: unknown;
  output?: unknown;
  arguments?: unknown;
  result?: unknown;
  isError?: boolean;
  ms?: number;
  stopReason?: string;
  error?: string;
  messageCount?: number;
}

export interface AgentRunResult {
  reply: string;
  iterations: number;
  stopReason: "completed" | "max_iterations";
  toolCallCount: number;
  model: string;
  provider: AgentProvider;
  ms: number;
}

const endpoint = "/api/local-agent";

/** 读取 Agent Harness 拓扑和经过脱敏的本地配置。 */
export function loadAgent(): Promise<AgentBootstrap> {
  return requestJson(endpoint);
}

/** 保存模型配置；服务端在必要时先测试连接。 */
export function saveAgentConfig(value: {
  agentModel: ModelConnectionSettingsInput;
  smallModel: ModelConnectionSettingsInput;
  sessionSearchWindow: number;
  sessionRecallMessageLimit: number;
  sessionRecallTokenLimit: number;
  modelContextWindow: number;
  maxTokens: number;
  maxIterations: number;
  retrievalMode: RetrievalMode;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingQueryTemplate: string;
  embeddingDocumentTemplate: string;
  embeddingMinimumSimilarity: number;
  embeddingApiKey: string;
  clearEmbeddingApiKey: boolean;
  force?: boolean;
}): Promise<{ ok: true; settings: AgentSettings; models: Record<"agentModel" | "smallModel", string[]> }> {
  return requestJson(`${endpoint}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

/** 恢复非模型运行参数默认值。 */
export function resetRuntimeConfig(): Promise<{ ok: true; settings: AgentSettings }> {
  return requestJson(`${endpoint}/config/reset-runtime`, { method: "POST" });
}

/** 建立完整影子向量索引，并在全部成功后原子激活。 */
export function rebuildEmbeddingIndex(): Promise<{ ok: true; settings: AgentSettings; result: { rebuildId: string; generationId: string; chunkCount: number } }> {
  return requestJson(`${endpoint}/config/rebuild-embeddings`, { method: "POST" });
}

export function cancelEmbeddingIndexRebuild(): Promise<{ ok: true; cancelled: boolean }> {
  return requestJson(`${endpoint}/config/cancel-embedding-rebuild`, { method: "POST" });
}

export interface ModelConnectionSettingsInput {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
}

/** 立即清除指定用途模型连接的本地 API Key。 */
export function clearModelApiKey(target: "agentModel" | "smallModel"): Promise<{ ok: true; settings: AgentSettings }> {
  return requestJson(`${endpoint}/config/clear-api-key`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target }),
  });
}

export function clearEmbeddingApiKey(): Promise<{ ok: true; settings: AgentSettings }> {
  return requestJson(`${endpoint}/config/clear-embedding-api-key`, { method: "POST" });
}

/** 显式更新 `.everything/EVERYTHING.md`。 */
export function saveSystemPrompt(systemPrompt: string): Promise<{ ok: true; systemPrompt: string }> {
  return requestJson(`${endpoint}/system-prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt }),
  });
}

/** 读取 `.everything/skills` 中的全部有效 Skill。 */
export function loadSkills(): Promise<{ skills: AgentSkill[] }> {
  return requestJson(`${endpoint}/skills`);
}

/** 新建、编辑或重命名一个 Skill。 */
export function saveSkill(value: {
  originalName?: string;
  name: string;
  description: string;
  instructions: string;
}): Promise<{ ok: true; skill: AgentSkill }> {
  return requestJson(`${endpoint}/skills`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

/** 永久删除 Skill 目录及其中的配套资源。 */
export function deleteSkill(name: string): Promise<{ ok: true }> {
  return requestJson(`${endpoint}/skills`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

/** 读取 Agent 当前工具目录；外部凭证只返回状态和末四位。 */
export function loadTools(): Promise<ToolsCatalog> {
  return requestJson(`${endpoint}/tools`);
}

/** 保存工具开关和 Tavily 配置，下一回合立即生效。 */
export function saveTools(value: {
  getCurrentTimeEnabled: boolean;
  searchWebEnabled: boolean;
  tavilyApiKey: string;
  clearTavilyApiKey: boolean;
}): Promise<{ ok: true } & ToolsCatalog> {
  return requestJson(`${endpoint}/tools`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

export function loadMemory(): Promise<MemoryDashboard> {
  return requestJson(`${endpoint}/memory`);
}

export async function memoryAction<T = unknown>(value: Record<string, unknown>): Promise<T> {
  const response = await requestJson<{ ok: true; result: T }>(`${endpoint}/memory`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
  return response.result;
}

export function loadTraces(): Promise<TraceDashboard> {
  return requestJson(`${endpoint}/traces`);
}

/** 读取 state.db 中排除索引中间表后的普通表。 */
export function loadDatabase(): Promise<DatabaseDashboard> {
  return requestJson(`${endpoint}/database`);
}

/** 执行 SQL；数据写操作仅在页面完成二次确认后携带确认令牌。 */
export function runDatabaseSql(sql: string, confirmed = false): Promise<DatabaseQueryResult> {
  return requestJson(`${endpoint}/database/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sql, confirmation: confirmed ? "CONFIRM_DATABASE_WRITE" : undefined }),
  });
}

/** 判断页面是否需要在提交 SQL 前展示写操作确认框。 */
export function databaseSqlNeedsConfirmation(sql: string): boolean {
  const statement = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/, "").toLowerCase();
  return /^(insert|update|delete)\b/.test(statement);
}

/** 清除所有本地 Agent 运行数据；已配置 Embedding 时随后建立新的空索引。 */
export async function clearAllAgentData(rebuildEmbeddings = false): Promise<{
  ok: true;
  cleared: true;
  embeddingRebuild: Awaited<ReturnType<typeof rebuildEmbeddingIndex>> | null;
}> {
  const cleared = await requestJson<{ ok: true; cleared: true }>(`${endpoint}/clear-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE_ALL_LOCAL_DATA" }),
  });
  let embeddingRebuild: Awaited<ReturnType<typeof rebuildEmbeddingIndex>> | null = null;
  if (rebuildEmbeddings) {
    try {
      embeddingRebuild = await rebuildEmbeddingIndex();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`本地数据已清理，但自动重建向量索引失败：${message}`, { cause: error });
    }
  }
  return { ...cleared, embeddingRebuild };
}

/** 执行一次 Agent 回合并消费服务端 NDJSON observer 事件。 */
export async function runAgent(
  prompt: string,
  sessionId: string,
  onEvent: (kind: string, event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<AgentRunResult> {
  const response = await fetch(`${endpoint}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, sessionId }),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await responseError(response));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AgentRunResult | null = null;
  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    const message = JSON.parse(line) as {
      type: "event" | "result" | "error";
      kind?: string;
      event?: AgentEvent;
      result?: AgentRunResult;
      error?: string;
    };
    if (message.type === "event" && message.kind && message.event) onEvent(message.kind, message.event);
    if (message.type === "result" && message.result) result = message.result;
    if (message.type === "error") throw new Error(message.error || "Agent 执行失败");
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consumeLine(line);
    if (done) break;
  }
  consumeLine(buffer);
  if (!result) throw new Error("本地 Agent 未返回执行结果");
  return result;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(await responseError(response));
  return response.json() as Promise<T>;
}

async function responseError(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const value = JSON.parse(text) as { error?: string; canForce?: boolean };
    const error = new Error(value.error || text) as Error & { canForce?: boolean };
    error.canForce = value.canForce;
    throw error;
  } catch (error) {
    if (error instanceof Error && "canForce" in error) throw error;
    return text || `请求失败（${response.status}）`;
  }
}

/** 独立订阅后台记忆事件，聊天完成后仍保持连接。 */
export function subscribeBackgroundEvents(onEvent: (kind: string, event: AgentEvent) => void): () => void {
  const source = new EventSource(`${endpoint}/background-events`);
  source.onmessage = (message) => {
    const { kind, event } = JSON.parse(message.data) as { kind: string; event: AgentEvent };
    onEvent(kind, event);
  };
  return () => source.close();
}
