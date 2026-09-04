import type { Workflow } from "./workflow-api";

export type AgentProvider = "anthropic" | "openai-compatible";

export interface AgentSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  sessionSearchWindow: number;
  sessionScrollStep: number;
  sessionRecallMessageLimit: number;
  sessionRecallCharacterLimit: number;
  contextCharacterLimit: number;
  limits: Record<string, { min: number; max: number }>;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

export interface AgentBootstrap {
  workflow: Workflow;
  settings: AgentSettings;
  systemPrompt: string;
  sessions: SessionSummary[];
}

export interface SessionSummary {
  id: string;
  title: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  pendingMessages: number;
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
  retrievalSignals: { bm25?: number };
  match: null | { messageId: number; bm25: number; totalMatches: number };
  entries: ChatLogEntry[];
  totalMessageCount: number;
  returnedMessageCount: number;
  indexedMessageCount: number;
  returnedRanges: Array<{ fromMessageId: number; toMessageId: number }>;
  isComplete: boolean;
  truncated: boolean;
  expandLimitReached: boolean;
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
  mode: "expand" | "sequential";
  session: SessionSummary;
  entries: ChatLogEntry[];
  totalMessageCount: number;
  returnedMessageCount: number;
  returnedRanges: Array<{ fromMessageId: number; toMessageId: number }>;
  isComplete: boolean;
  truncated: boolean;
  expandLimitReached: boolean;
  nextCursor: string | null;
}

export interface SemanticMemory {
  id: number; subject: string; content: string; source: string; createdAt: string; updatedAt: string;
}

export interface ConsolidationRun {
  id: number; runId: string; sessionId: string; trigger: string; status: string; throughMessageId: number;
  factsCreated: number; factsUpdated: number; factsSkipped: number;
  errorType: string | null; startedAt: string; completedAt: string | null;
}

export interface MemoryDashboard {
  overview: { semanticCount: number; indexedSessionCount: number; indexedMessageCount: number; sessionCount: number; pendingSessionCount: number; databasePath: string; latestConsolidation: ConsolidationRun | null };
  sessions: SessionSummary[];
  semantic: SemanticMemory[];
  chatLog: ChatLogEntry[];
  consolidations: ConsolidationRun[];
}

export interface TraceRecord {
  version: number; eventId?: string; type: string; timestamp: string; sequence?: number; runId: string; sessionId?: string;
  iteration?: number; modelCallId?: string; toolCallId?: string; payload?: Record<string, unknown>; [key: string]: unknown;
}

export interface TraceDashboard {
  records: TraceRecord[];
  sessions: SessionSummary[];
}

export interface ClientHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentEvent {
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
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  smallModel: string;
  sessionSearchWindow: number;
  sessionScrollStep: number;
  sessionRecallMessageLimit: number;
  sessionRecallCharacterLimit: number;
  contextCharacterLimit: number;
  force?: boolean;
}): Promise<{ ok: true; settings: AgentSettings; models: string[] }> {
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

/** 显式更新 `.everything/EVERYTHING.md`。 */
export function saveSystemPrompt(systemPrompt: string): Promise<{ ok: true; systemPrompt: string }> {
  return requestJson(`${endpoint}/system-prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ systemPrompt }),
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

/** 清除所有本地 Agent 数据；服务端只保留 EVERYTHING.md。 */
export function clearAllAgentData(): Promise<{ ok: true; cleared: true }> {
  return requestJson(`${endpoint}/clear-data`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmation: "DELETE_ALL_LOCAL_DATA" }),
  });
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
