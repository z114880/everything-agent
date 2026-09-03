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
} from "../../src/index.js";
import type {
  AgentMessage,
  AgentObserver,
  AgentProvider,
  ToolCallRecord,
} from "../../src/index.js";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
const everythingHome = fileURLToPath(new URL("../../.everything/", import.meta.url));
const systemPromptPath = fileURLToPath(new URL("../../.everything/EVERYTHING.md", import.meta.url));
const legacySystemPromptPath = fileURLToPath(new URL("../../EVERYTHING.md", import.meta.url));
const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const CONFIG_KEYS = [
  "EVERYTHING_PROVIDER",
  "EVERYTHING_MODEL",
  "EVERYTHING_SMALL_MODEL",
  "EVERYTHING_HISTORY_TURNS",
  "EVERYTHING_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

interface RuntimeSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  historyTurns: number;
  baseUrl: string;
  apiKey: string;
  keyName: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
}

/** 可安全发送到浏览器的本地 Agent 配置。 */
export interface PublicAgentSettings {
  provider: AgentProvider;
  model: string;
  smallModel: string;
  historyTurns: number;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

let memoryRuntime: MemoryRuntime | null = null;
let tracer: JsonlTracer | null = null;
let manageMemoryTool: ManageMemoryTool | null = null;
let recoveryScheduled = false;
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
  const historyTurns = parseHistoryTurns(body.historyTurns ?? 10);
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
    EVERYTHING_HISTORY_TURNS: String(historyTurns),
    EVERYTHING_BASE_URL: effectiveBaseUrl,
  };
  if (apiKey) updates[keyName] = apiKey;
  await updateEnvFile(updates, clearApiKey ? [keyName] : []);
  const settings = await loadRuntimeSettings();
  return { settings: publicSettings(settings), models };
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
  const prompt = requiredText(body.prompt, "User Prompt", 40_000);
  const sessionId = requiredText(body.sessionId, "Session ID", 200);
  const settings = await loadRuntimeSettings();
  if (!settings.apiKey) throw new Error(`请先在配置页填写 ${settings.keyName}`);
  if (!settings.model) throw new Error("请先在配置页填写 Model");

  return withSessionLock(sessionId, async () => {
    const memory = getMemoryRuntime();
    const trace = getTracer();
    const client = createModelClient(settings);
    const runId = crypto.randomUUID();
    const startedAt = performance.now();
    memory.startRun(sessionId, runId, prompt);
    await trace.record("turn_start", { runId, sessionId });
    const emit: AgentObserver = async (kind, event) => {
      const enriched = { ...event, runId, sessionId };
      await observer(kind, enriched);
      if (["working_memory", "gate_start", "gate_end", "retrieval", "llm_start", "llm_end", "tool_start", "tool_end"].includes(kind)) {
        const modelFields = kind.startsWith("llm") ? { provider: settings.provider, model: settings.model } : {};
        await trace.record(kind, { ...enriched, ...modelFields });
      }
    };
    try {
      const history = memory.getWorkingMemory(sessionId, settings.historyTurns);
      const gateHistory = memory.getWorkingMemory(sessionId, 3);
      const retrieval = await memory.retrieve(prompt, gateHistory, {
        client,
        model: settings.smallModel || settings.model,
        observer: emit,
      });
      const messages: AgentMessage[] = [...history, { role: "user", content: prompt }];
      const appendedFrom = messages.length;
      const baseSystem = await readSystemPrompt();
      const result = await runAgentLoop({
        client,
        model: settings.model,
        system: [baseSystem, retrieval.context].filter(Boolean).join("\n\n"),
        messages,
        tools: new LocalToolRegistry(memory, getManageMemoryTool(memory)),
        maxIterations: 10,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        stream: true,
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
      await trace.record("turn_end", { runId, sessionId, iterations: result.iterations, stopReason: result.stopReason, ms });
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
      await trace.record("turn_error", {
        runId,
        sessionId,
        errorType: error instanceof Error ? error.name : "UnknownError",
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
    await getTracer().record("session_created", { runId: crypto.randomUUID(), sessionId: session.id });
    if (previousSessionId) scheduleSessionConsolidation(memory, previousSessionId, "new_session");
    return { session, sessions: memory.listSessions() };
  }
  if (action === "select_session") {
    const sessionId = requiredText(body.sessionId, "Session ID", 200);
    await getTracer().record("session_selected", { runId: crypto.randomUUID(), sessionId });
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
  if (action === "create_episodic") return memory.createEpisodic(requiredText(body.summary, "Summary", 20_000), parseTimestamp(body.happenedAt), "ui");
  if (action === "search_episodic") return memory.searchEpisodic(requiredText(body.query, "Query", 2_000), 100);
  if (action === "update_episodic") return memory.updateEpisodic(positiveId(body.id), requiredText(body.summary, "Summary", 20_000), parseTimestamp(body.happenedAt), "ui");
  if (action === "delete_episodic") return void memory.deleteEpisodic(positiveId(body.id), "ui");
  throw new TypeError("未知 Memory action");
}

export async function loadTraceDashboard(): Promise<unknown> {
  return { records: await readTraceRecords(everythingHome, 2_000) };
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
    historyTurns: parseHistoryTurns(values.EVERYTHING_HISTORY_TURNS || 10),
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
  return {
    tool: call.tool,
    toolUseId: call.toolUseId,
    iteration: call.iteration,
    isError: call.isError,
    args: removeCredentials(call.args),
    output: removeCredentials(call.output),
    outputLength: call.output.length,
    summary: call.isError ? "工具执行失败" : "工具执行完成",
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
    historyTurns: settings.historyTurns,
    baseUrl: settings.baseUrl,
    keyConfigured: Boolean(settings.apiKey),
    keyLast4: settings.apiKey ? settings.apiKey.slice(-4) : "",
  };
}

function parseHistoryTurns(value: unknown): number {
  const number = typeof value === "string" && value.trim() ? Number(value) : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 50) throw new TypeError("History Turns 必须是 1–50 的整数");
  return number;
}

function positiveId(value: unknown): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new TypeError("ID 必须是正整数");
  return number;
}

function parseTimestamp(value: unknown): string {
  const text = requiredText(value, "时间", 100);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new TypeError("时间格式无效");
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
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
    episodic: memory.listEpisodic(),
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
    if (settings.apiKey && (settings.smallModel || settings.model)) {
      memory.scheduleConsolidation(sessionId, trigger, consolidationOptions(settings));
    }
  });
}

function consolidationOptions(settings: RuntimeSettings) {
  return {
    client: createModelClient(settings),
    model: settings.smallModel || settings.model,
    observer: (kind: string, event: Record<string, unknown>) => getTracer().record(kind, event),
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
  if (/api[-_]?key|authorization|cookie|token|secret|password/i.test(key)) return "[凭证已移除]";
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
