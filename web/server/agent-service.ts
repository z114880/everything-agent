import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import {
  agentHarnessGraph,
  createModelClient,
  LocalToolRegistry,
  MemoryRuntime,
  ManageMemoryTool,
  JsonlTracer,
  readTraceRecords,
  runAgentLoop,
} from "../../src/index.ts";
import type {
  AgentMessage,
  AgentModelClient,
  AgentObserver,
  AgentProvider,
  SessionRecallSettings,
  ToolCallRecord,
} from "../../src/index.ts";
import { clearEverythingData } from "./local-data.ts";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
const everythingHome = fileURLToPath(new URL("../../.everything/", import.meta.url));
const systemPromptPath = fileURLToPath(new URL("../../.everything/EVERYTHING.md", import.meta.url));
const legacySystemPromptPath = fileURLToPath(new URL("../../EVERYTHING.md", import.meta.url));
const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible"]);
const DEFAULT_TIMEOUT_MS = 60_000;
export const RUNTIME_DEFAULTS = {
  sessionSearchWindow: 5,
  sessionScrollStep: 10,
  sessionRecallMessageLimit: 100,
  sessionRecallCharacterLimit: 50_000,
  contextCharacterLimit: 200_000,
} as const;
const CONFIG_KEYS = [
  "EVERYTHING_PROVIDER",
  "EVERYTHING_MODEL",
  "EVERYTHING_SMALL_MODEL",
  "EVERYTHING_SESSION_SEARCH_WINDOW",
  "EVERYTHING_SESSION_SCROLL_STEP",
  "EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT",
  "EVERYTHING_SESSION_RECALL_CHARACTER_LIMIT",
  "EVERYTHING_CONTEXT_CHARACTER_LIMIT",
  "EVERYTHING_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

interface RuntimeSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  sessionSearchWindow: number;
  sessionScrollStep: number;
  sessionRecallMessageLimit: number;
  sessionRecallCharacterLimit: number;
  contextCharacterLimit: number;
  baseUrl: string;
  apiKey: string;
  keyName: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
}

/** 可安全发送到浏览器的本地 Agent 配置。 */
export interface PublicAgentSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  sessionSearchWindow: number;
  sessionScrollStep: number;
  sessionRecallMessageLimit: number;
  sessionRecallCharacterLimit: number;
  contextCharacterLimit: number;
  limits: typeof SETTING_LIMITS;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

const SETTING_LIMITS = {
  sessionSearchWindow: { min: 1, max: 20 },
  sessionScrollStep: { min: 1, max: 50 },
  sessionRecallMessageLimit: { min: 1, max: 200 },
  sessionRecallCharacterLimit: { min: 1_000, max: 100_000 },
  contextCharacterLimit: { min: 10_000, max: 1_000_000 },
} as const;

let memoryRuntime: MemoryRuntime | null = null;
let tracer: JsonlTracer | null = null;
let manageMemoryTool: ManageMemoryTool | null = null;
let recoveryScheduled = false;
let dataClearing = false;
const sessionLocks = new Map<string, Promise<void>>();

/** 配置保存失败时携带是否允许强制保存。 */
export class AgentConfigError extends Error {
  readonly canForce: boolean;

  constructor(message: string, canForce = false) {
    super(message);
    this.name = "AgentConfigError";
    this.canForce = canForce;
  }
}

/** 读取 Agent 页面首次渲染所需的真实拓扑、配置和 System Prompt。 */
export async function loadAgentBootstrap(): Promise<Record<string, unknown>> {
  const settings = await loadRuntimeSettings();
  const memory = getMemoryRuntime();
  scheduleStartupRecovery(memory, settings);
  return {
    workflow: toWorkflow(),
    settings: publicSettings(settings),
    systemPrompt: await readSystemPrompt(),
    sessions: memory.listSessions(),
  };
}

/** 保存模型配置；密钥永远不会出现在返回值中。 */
export async function saveAgentSettings(body: Record<string, unknown>): Promise<{
  settings: PublicAgentSettings;
  models: string[];
}> {
  const provider = parseProvider(body.provider);
  const model = requiredText(body.model, "Model", 200);
  const smallModel = optionalText(body.smallModel, "Small Model", 200);
  const runtime = parseRuntimeSettingBody(body);
  const baseUrl = optionalText(body.baseUrl, "Base URL", 2_000);
  const effectiveBaseUrl = provider === "openai-compatible" ? baseUrl : "";
  if (effectiveBaseUrl) validateBaseUrl(effectiveBaseUrl);
  const apiKey = optionalText(body.apiKey, "API Key", 10_000);
  const clearApiKey = body.clearApiKey === true;
  const force = body.force === true;
  const before = await readEnvValues();
  const keyName = keyNameFor(provider);
  const currentKey = before[keyName] ?? "";
  const currentBaseUrl = before.EVERYTHING_BASE_URL ?? "";
  const candidateKey = clearApiKey ? "" : apiKey || currentKey;
  const keyChanged = Boolean(apiKey && apiKey !== currentKey);
  const baseChanged = provider === "openai-compatible" && effectiveBaseUrl !== currentBaseUrl;
  let models: string[] = [];

  if (!clearApiKey && candidateKey && (keyChanged || baseChanged) && !force) {
    try {
      models = await probeModels(provider, candidateKey, effectiveBaseUrl);
    } catch (error) {
      throw new AgentConfigError(sanitizeError(error, [candidateKey]), true);
    }
  }

  const updates: Record<string, string> = {
    EVERYTHING_PROVIDER: provider,
    EVERYTHING_MODEL: model,
    EVERYTHING_SMALL_MODEL: smallModel,
    EVERYTHING_SESSION_SEARCH_WINDOW: String(runtime.sessionSearchWindow),
    EVERYTHING_SESSION_SCROLL_STEP: String(runtime.sessionScrollStep),
    EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT: String(runtime.sessionRecallMessageLimit),
    EVERYTHING_SESSION_RECALL_CHARACTER_LIMIT: String(runtime.sessionRecallCharacterLimit),
    EVERYTHING_CONTEXT_CHARACTER_LIMIT: String(runtime.contextCharacterLimit),
    EVERYTHING_BASE_URL: effectiveBaseUrl,
  };
  if (apiKey) updates[keyName] = apiKey;
  await updateEnvFile(updates, clearApiKey ? [keyName] : []);
  const settings = await loadRuntimeSettings();
  return { settings: publicSettings(settings), models };
}

/** 恢复全部运行参数默认值，保留模型连接和 EVERYTHING.md。 */
export async function resetRuntimeSettings(): Promise<{ settings: PublicAgentSettings }> {
  await updateEnvFile({
    EVERYTHING_SESSION_SEARCH_WINDOW: String(RUNTIME_DEFAULTS.sessionSearchWindow),
    EVERYTHING_SESSION_SCROLL_STEP: String(RUNTIME_DEFAULTS.sessionScrollStep),
    EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallMessageLimit),
    EVERYTHING_SESSION_RECALL_CHARACTER_LIMIT: String(RUNTIME_DEFAULTS.sessionRecallCharacterLimit),
    EVERYTHING_CONTEXT_CHARACTER_LIMIT: String(RUNTIME_DEFAULTS.contextCharacterLimit),
  }, ["EVERYTHING_HISTORY_TURNS"]);
  return { settings: publicSettings(await loadRuntimeSettings()) };
}

/** 显式保存 procedural memory，并让下一回合立即读取新内容。 */
export async function saveSystemPrompt(body: Record<string, unknown>): Promise<string> {
  const systemPrompt = requiredText(body.systemPrompt, "System Prompt", 100_000);
  await atomicWrite(systemPromptPath, `${systemPrompt.trimEnd()}\n`, 0o644);
  return systemPrompt.trimEnd();
}

/** 执行一次真实 Agent 回合，并通过 observer 流式暴露可观察事件。 */
export async function runLocalAgent(
  body: Record<string, unknown>,
  observer: AgentObserver,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  if (dataClearing) throw new Error("本地数据正在清理，请稍后重试");
  const prompt = requiredText(body.prompt, "User Prompt", 40_000);
  const sessionId = requiredText(body.sessionId, "Session ID", 200);
  const settings = await loadRuntimeSettings();
  if (!settings.apiKey) throw new Error(`请先在配置页填写 ${settings.keyName}`);
  if (!settings.model) throw new Error("请先在配置页填写 Model");

  return withSessionLock(sessionId, async () => {
    const memory = getMemoryRuntime();
    const trace = getTracer();
    const client = createRuntimeClient(settings);
    const runId = crypto.randomUUID();
    const startedAt = performance.now();
    memory.startRun(sessionId, runId, prompt);
    await trace.record("run_started", {
      runId,
      sessionId,
      userInput: prompt,
      provider: settings.provider,
      model: settings.model,
      settings: {
        contextCharacterLimit: settings.contextCharacterLimit,
        sessionRecall: recallSettings(settings),
        maxIterations: 10,
        maxTokens: 2_048,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        stream: true,
      },
      runtime: { nodeVersion: process.version, traceSchemaVersion: 2 },
    });
    let contextMetadata: Record<string, unknown> = {};
    const emit: AgentObserver = async (kind, event) => {
      const enriched = { ...event, ...(kind === "context_assembled" ? contextMetadata : {}), runId, sessionId };
      await observer(kind, enriched);
      if (["context_assembled", "gate_start", "gate_end", "retrieval", "model_request", "model_response", "model_failed", "stream_fallback", "tool_started", "tool_completed", "tool_failed"].includes(kind)) {
        const modelFields = kind.startsWith("model_") ? { provider: settings.provider, model: settings.model } : {};
        await trace.record(kind, { ...enriched, ...modelFields });
      }
    };
    try {
      const history = memory.getWorkingMemory(sessionId);
      const gateHistory = memory.getWorkingMemory(sessionId, 3);
      const retrieval = await memory.retrieve(prompt, gateHistory, {
        client,
        model: settings.smallModel || settings.model,
        currentSessionId: sessionId,
        recall: recallSettings(settings),
        observer: emit,
      });
      const messages: AgentMessage[] = [...history, { role: "user", content: prompt }];
      const appendedFrom = messages.length;
      const baseSystem = await readSystemPrompt();
      contextMetadata = {
        historyMessageCount: history.length,
        semanticMemoryIds: retrieval.semantic.map((item) => item.id),
        sessionRecallSessionIds: retrieval.sessionRecall?.sessions.map((item) => item.session.id) ?? [],
        sessionRecallRanges: retrieval.sessionRecall?.sessions.map((item) => ({ sessionId: item.session.id, ranges: item.returnedRanges })) ?? [],
        sessionRecallEntryCount: retrieval.sessionRecall?.sessions.reduce((sum, item) => sum + item.returnedMessageCount, 0) ?? 0,
        sessionRecallCharacterCount: retrieval.sessionRecall
          ? JSON.stringify(retrieval.sessionRecall.sessions.flatMap((item) => item.entries)).length
          : 0,
        sessionRecallTruncated: retrieval.sessionRecall?.truncated ?? false,
      };
      const result = await runAgentLoop({
        client,
        model: settings.model,
        system: [baseSystem, retrieval.context].filter(Boolean).join("\n\n"),
        messages,
        tools: new LocalToolRegistry(memory, getManageMemoryTool(memory), {
          currentSessionId: sessionId,
          settings: recallSettings(settings),
        }),
        maxIterations: 10,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        stream: true,
        contextCharacterLimit: settings.contextCharacterLimit,
        signal,
        observer: emit,
        serializeToolEvent: publicToolEvent,
        runId,
      });
      const appended = messages.slice(appendedFrom);
      if (!isFinalAssistantMessage(appended.at(-1))) {
        appended.push({ role: "assistant", content: [{ type: "text", text: result.reply }] });
      }
      memory.completeRun(sessionId, runId, appended);
      const ms = Math.round(performance.now() - startedAt);
      await trace.record("run_completed", {
        runId,
        sessionId,
        reply: result.reply,
        iterations: result.iterations,
        stopReason: result.stopReason,
        toolCallCount: result.toolCalls.length,
        ms,
      });
      return {
        reply: result.reply,
        iterations: result.iterations,
        stopReason: result.stopReason,
        toolCallCount: result.toolCalls.length,
        model: settings.model,
        provider: settings.provider,
        ms,
        runId,
      };
    } catch (error) {
      await trace.record("run_failed", {
        runId,
        sessionId,
        errorType: error instanceof Error ? error.name : "UnknownError",
        errorMessage: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - startedAt),
      });
      throw error;
    }
  });
}

/** Session、Memory 与 trace 页面共用的本地只读/写入操作。 */
export async function handleMemoryAction(body: Record<string, unknown>): Promise<unknown> {
  const memory = getMemoryRuntime();
  const action = requiredText(body.action, "action", 80);
  if (action === "bootstrap") return memoryDashboard(memory);
  if (action === "create_session") {
    const previousSessionId = optionalText(body.previousSessionId, "Previous Session ID", 200);
    const session = memory.createSession();
    if (previousSessionId) scheduleSessionConsolidation(memory, previousSessionId, "new_session");
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
  if (action === "create_semantic") return memory.createSemantic(requiredText(body.subject, "Subject", 500), requiredText(body.content, "Content", 20_000), "ui");
  if (action === "search_semantic") return memory.searchSemantic(requiredText(body.query, "Query", 2_000), 100);
  if (action === "update_semantic") return memory.updateSemantic(positiveId(body.id), requiredText(body.subject, "Subject", 500), requiredText(body.content, "Content", 20_000), "ui");
  if (action === "delete_semantic") return void memory.deleteSemantic(positiveId(body.id), "ui");
  if (action === "session_search") {
    const settings = await loadRuntimeSettings();
    return memory.searchSessions({
      query: body.query === undefined ? undefined : requiredText(body.query, "Query", 2_000),
      recent: body.recent === true,
      limit: body.limit === undefined ? undefined : Number(body.limit),
      window: body.window === undefined ? undefined : Number(body.window),
    }, recallSettings(settings));
  }
  if (action === "session_read") {
    const settings = await loadRuntimeSettings();
    return memory.readSession({
      sessionId: body.sessionId === undefined ? undefined : requiredText(body.sessionId, "Session ID", 200),
      cursor: body.cursor === undefined ? undefined : requiredText(body.cursor, "Cursor", 10_000),
    }, recallSettings(settings));
  }
  throw new TypeError("未知 Memory action");
}

export async function loadTraceDashboard(): Promise<unknown> {
  return {
    records: await readTraceRecords(everythingHome, 2_000),
    sessions: getMemoryRuntime().listSessions(),
  };
}

/** 清除数据库、Session、Memory 与 trace，仅保留 EVERYTHING.md。 */
export async function clearLocalAgentData(body: Record<string, unknown>): Promise<{ cleared: true }> {
  if (body.confirmation !== "DELETE_ALL_LOCAL_DATA") throw new TypeError("缺少清理确认");
  if (dataClearing) throw new Error("本地数据正在清理");
  if (sessionLocks.size > 0) throw new Error("仍有 Agent 回合正在运行，请结束后再清理");
  dataClearing = true;
  try {
    if (memoryRuntime) await memoryRuntime.waitForConsolidation();
    if (tracer) await tracer.flush();
    memoryRuntime?.close();
    memoryRuntime = null;
    tracer = null;
    manageMemoryTool = null;
    recoveryScheduled = false;
    await clearEverythingData(everythingHome);
    return { cleared: true };
  } finally {
    dataClearing = false;
  }
}

/** 解析 dotenv 的常见 KEY=VALUE 语法，不向进程全局注入未知字段。 */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]!] = decodeEnvValue(match[2] ?? "");
  }
  return values;
}

/** 保留注释和无关字段，仅更新明确列出的配置键。 */
export function updateEnvText(
  text: string,
  updates: Record<string, string>,
  clears: readonly string[] = [],
): string {
  const remaining = new Map(Object.entries(updates));
  const clearSet = new Set(clears);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || (!remaining.has(key) && !clearSet.has(key))) {
      lines.push(line);
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (clearSet.has(key)) continue;
    lines.push(`${key}=${encodeEnvValue(remaining.get(key)!)}`);
    remaining.delete(key);
  }
  while (lines.at(-1) === "") lines.pop();
  for (const [key, value] of remaining) lines.push(`${key}=${encodeEnvValue(value)}`);
  return `${lines.join("\n")}\n`;
}

async function loadRuntimeSettings(): Promise<RuntimeSettings> {
  const values = await readEnvValues();
  const provider = parseProvider(values.EVERYTHING_PROVIDER || "anthropic");
  const keyName = keyNameFor(provider);
  return {
    provider,
    model: values.EVERYTHING_MODEL ?? "",
    smallModel: values.EVERYTHING_SMALL_MODEL ?? "",
    sessionSearchWindow: parseSetting(values.EVERYTHING_SESSION_SEARCH_WINDOW, "Session Search Window", RUNTIME_DEFAULTS.sessionSearchWindow, SETTING_LIMITS.sessionSearchWindow),
    sessionScrollStep: parseSetting(values.EVERYTHING_SESSION_SCROLL_STEP, "Session Scroll Step", RUNTIME_DEFAULTS.sessionScrollStep, SETTING_LIMITS.sessionScrollStep),
    sessionRecallMessageLimit: parseSetting(values.EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT, "Session Recall Message Limit", RUNTIME_DEFAULTS.sessionRecallMessageLimit, SETTING_LIMITS.sessionRecallMessageLimit),
    sessionRecallCharacterLimit: parseSetting(values.EVERYTHING_SESSION_RECALL_CHARACTER_LIMIT, "Session Recall Character Limit", RUNTIME_DEFAULTS.sessionRecallCharacterLimit, SETTING_LIMITS.sessionRecallCharacterLimit),
    contextCharacterLimit: parseSetting(values.EVERYTHING_CONTEXT_CHARACTER_LIMIT, "Context Character Limit", RUNTIME_DEFAULTS.contextCharacterLimit, SETTING_LIMITS.contextCharacterLimit),
    baseUrl: values.EVERYTHING_BASE_URL ?? "",
    apiKey: values[keyName] ?? "",
    keyName,
  };
}

async function readEnvValues(): Promise<Record<string, string>> {
  const inherited = Object.fromEntries(CONFIG_KEYS.flatMap((key) => process.env[key] === undefined
    ? []
    : [[key, process.env[key]!]]));
  try {
    return { ...inherited, ...parseEnv(await readFile(envPath, "utf8")) };
  } catch (error) {
    if (isMissingFile(error)) return inherited;
    throw error;
  }
}

async function updateEnvFile(updates: Record<string, string>, clears: readonly string[]): Promise<void> {
  let current = "";
  try {
    current = await readFile(envPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  await atomicWrite(envPath, updateEnvText(current, updates, clears));
  for (const [key, value] of Object.entries(updates)) process.env[key] = value;
  for (const key of clears) delete process.env[key];
}

async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(everythingHome, { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await rename(temporary, path);
}

async function readSystemPrompt(): Promise<string> {
  try {
    return await readFile(systemPromptPath, "utf8");
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const legacy = await readFile(legacySystemPromptPath, "utf8");
    await atomicWrite(systemPromptPath, legacy, 0o644);
    return legacy;
  }
}

async function probeModels(
  provider: AgentProvider,
  apiKey: string,
  baseUrl: string,
): Promise<string[]> {
  const endpoint = provider === "anthropic"
    ? `${normalizeBaseUrl(baseUrl || "https://api.anthropic.com")}/v1/models`
    : `${normalizeBaseUrl(baseUrl || "https://api.openai.com/v1")}/models`;
  const headers: Record<string, string> = provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
  const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`连接测试失败（HTTP ${response.status}）：${detail}`);
  }
  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? []).map((item) => item.id ?? "").filter(Boolean).slice(0, 500);
}

function publicToolEvent(call: ToolCallRecord): Record<string, unknown> {
  const result = call.tool === "session_search" || call.tool === "session_read"
    ? sessionRecallToolMetadata(call.result)
    : removeCredentials(call.result);
  return {
    tool: call.tool,
    toolCallId: call.toolUseId,
    iteration: call.iteration,
    isError: call.isError,
    arguments: removeCredentials(call.args),
    result,
    outputLength: call.output.length,
    summary: call.isError ? "工具执行失败" : "工具执行完成",
  };
}

function sessionRecallToolMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const result = value as Record<string, unknown>;
  if (Array.isArray(result.sessions)) {
    return {
      retrievalMode: result.retrievalMode,
      requestedLimit: result.requestedLimit,
      returnedSessionCount: result.returnedSessionCount,
      droppedSessionCount: result.droppedSessionCount,
      truncated: result.truncated,
      sessions: result.sessions.map((item) => {
        const sessionResult = item as Record<string, unknown>;
        const session = sessionResult.session as Record<string, unknown> | undefined;
        return {
          sessionId: session?.id,
          rank: sessionResult.rank,
          match: sessionResult.match,
          retrievalSignals: sessionResult.retrievalSignals,
          returnedMessageCount: sessionResult.returnedMessageCount,
          returnedRanges: sessionResult.returnedRanges,
          isComplete: sessionResult.isComplete,
          truncated: sessionResult.truncated,
        };
      }),
    };
  }
  const session = result.session as Record<string, unknown> | undefined;
  return {
    mode: result.mode,
    sessionId: session?.id,
    totalMessageCount: result.totalMessageCount,
    returnedMessageCount: result.returnedMessageCount,
    returnedRanges: result.returnedRanges,
    isComplete: result.isComplete,
    truncated: result.truncated,
    expandLimitReached: result.expandLimitReached,
  };
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

function publicSettings(settings: RuntimeSettings): PublicAgentSettings {
  return {
    provider: settings.provider,
    model: settings.model,
    smallModel: settings.smallModel,
    sessionSearchWindow: settings.sessionSearchWindow,
    sessionScrollStep: settings.sessionScrollStep,
    sessionRecallMessageLimit: settings.sessionRecallMessageLimit,
    sessionRecallCharacterLimit: settings.sessionRecallCharacterLimit,
    contextCharacterLimit: settings.contextCharacterLimit,
    limits: SETTING_LIMITS,
    baseUrl: settings.baseUrl,
    keyConfigured: Boolean(settings.apiKey),
    keyLast4: settings.apiKey ? settings.apiKey.slice(-4) : "",
  };
}

function parseRuntimeSettingBody(body: Record<string, unknown>) {
  return {
    sessionSearchWindow: parseSetting(body.sessionSearchWindow, "Session Search Window", RUNTIME_DEFAULTS.sessionSearchWindow, SETTING_LIMITS.sessionSearchWindow),
    sessionScrollStep: parseSetting(body.sessionScrollStep, "Session Scroll Step", RUNTIME_DEFAULTS.sessionScrollStep, SETTING_LIMITS.sessionScrollStep),
    sessionRecallMessageLimit: parseSetting(body.sessionRecallMessageLimit, "Session Recall Message Limit", RUNTIME_DEFAULTS.sessionRecallMessageLimit, SETTING_LIMITS.sessionRecallMessageLimit),
    sessionRecallCharacterLimit: parseSetting(body.sessionRecallCharacterLimit, "Session Recall Character Limit", RUNTIME_DEFAULTS.sessionRecallCharacterLimit, SETTING_LIMITS.sessionRecallCharacterLimit),
    contextCharacterLimit: parseSetting(body.contextCharacterLimit, "Context Character Limit", RUNTIME_DEFAULTS.contextCharacterLimit, SETTING_LIMITS.contextCharacterLimit),
  };
}

function parseSetting(value: unknown, name: string, fallback: number, limits: { min: number; max: number }): number {
  const number = value === undefined || value === "" ? fallback : Number(value);
  if (!Number.isInteger(number) || number < limits.min || number > limits.max) {
    throw new TypeError(`${name} 必须是 ${limits.min}–${limits.max} 的整数`);
  }
  return number;
}

function positiveId(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError("ID 必须是正整数");
  return number;
}

function getMemoryRuntime(): MemoryRuntime {
  memoryRuntime ??= new MemoryRuntime(everythingHome);
  return memoryRuntime;
}

function getTracer(): JsonlTracer {
  tracer ??= new JsonlTracer(everythingHome);
  return tracer;
}

function getManageMemoryTool(memory: MemoryRuntime): ManageMemoryTool {
  manageMemoryTool ??= new ManageMemoryTool(memory);
  return manageMemoryTool;
}

function memoryDashboard(memory: MemoryRuntime): Record<string, unknown> {
  return {
    overview: memory.overview(),
    sessions: memory.listSessions(),
    semantic: memory.listSemantic(),
    chatLog: memory.getChatLog(undefined, 2_000),
    consolidations: memory.listConsolidations(),
  };
}

function scheduleStartupRecovery(memory: MemoryRuntime, settings: RuntimeSettings): void {
  if (recoveryScheduled || !settings.apiKey || !(settings.smallModel || settings.model)) return;
  recoveryScheduled = true;
  memory.schedulePendingConsolidations(consolidationOptions(settings));
}

function scheduleSessionConsolidation(memory: MemoryRuntime, sessionId: string, trigger: "new_session" | "startup"): void {
  void loadRuntimeSettings().then((settings) => {
    if (!dataClearing && memoryRuntime === memory && settings.apiKey && (settings.smallModel || settings.model)) {
      memory.scheduleConsolidation(sessionId, trigger, consolidationOptions(settings));
    }
  });
}

function consolidationOptions(settings: RuntimeSettings) {
  return {
    client: createRuntimeClient(settings),
    model: settings.smallModel || settings.model,
    currentSessionId: "",
    recall: recallSettings(settings),
    observer: (kind: string, event: Record<string, unknown>) => getTracer().record(kind, event),
  };
}

/** 对 Gate、Consolidation 与主 Agent 的每次模型请求统一执行字符预算。 */
function createRuntimeClient(settings: RuntimeSettings): AgentModelClient {
  const client = createModelClient(settings);
  const assertLimit = (request: { system: string; messages: AgentMessage[]; tools: unknown }) => {
    const characters = JSON.stringify({ system: request.system, messages: request.messages, tools: request.tools }).length;
    if (characters > settings.contextCharacterLimit) {
      throw new Error(`模型输入上下文为 ${characters} 字符，超过配置上限 ${settings.contextCharacterLimit}；请新建 Session 或调高 Context Limit`);
    }
  };
  return {
    messages: {
      create(request) { assertLimit(request); return client.messages.create(request) },
      ...(client.messages.stream ? {
        stream(request) { assertLimit(request); return client.messages.stream!(request) },
      } : {}),
    },
  };
}

function recallSettings(settings: RuntimeSettings): SessionRecallSettings {
  return {
    searchWindow: settings.sessionSearchWindow,
    scrollStep: settings.sessionScrollStep,
    messageLimit: settings.sessionRecallMessageLimit,
    characterLimit: settings.sessionRecallCharacterLimit,
  };
}

async function withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionLocks.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current);
  sessionLocks.set(sessionId, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (sessionLocks.get(sessionId) === tail) sessionLocks.delete(sessionId);
  }
}

function isFinalAssistantMessage(message: AgentMessage | undefined): boolean {
  return Boolean(message?.role === "assistant" && Array.isArray(message.content)
    && !message.content.some((block: { type?: string }) => block.type === "tool_use"));
}

function removeCredentials(value: unknown, key = ""): unknown {
  const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  if (/(?:^|_)(?:api_key|authorization|cookie|token|access_token|refresh_token|auth_token|secret|client_secret|password)(?:$|_)/.test(normalizedKey)) {
    return "[凭证已移除]";
  }
  if (Array.isArray(value)) return value.map((item) => removeCredentials(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([itemKey, itemValue]) => [itemKey, removeCredentials(itemValue, itemKey)]));
}

function parseProvider(value: unknown): AgentProvider {
  if (typeof value !== "string" || !VALID_PROVIDERS.has(value as AgentProvider)) {
    throw new TypeError("Provider 必须是 anthropic 或 openai-compatible");
  }
  return value as AgentProvider;
}

function keyNameFor(provider: AgentProvider): RuntimeSettings["keyName"] {
  return provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
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

function decodeEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "").trim();
}

function encodeEnvValue(value: string): string {
  return JSON.stringify(value);
}

function validateBaseUrl(value: string): void {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new TypeError("Base URL 只支持 HTTP 或 HTTPS");
}

function normalizeBaseUrl(value: string): string {
  validateBaseUrl(value);
  return value.replace(/\/$/, "");
}

function sanitizeError(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "***");
  return message;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
