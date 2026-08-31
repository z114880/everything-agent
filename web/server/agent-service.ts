import { readFile, rename, writeFile } from "node:fs/promises";
import { fileURLToPath, URL } from "node:url";
import {
  agentHarnessGraph,
  createModelClient,
  LocalToolRegistry,
  runAgentLoop,
} from "../../src/index.js";
import type {
  AgentMessage,
  AgentObserver,
  AgentProvider,
  ToolCallRecord,
} from "../../src/index.js";

const envPath = fileURLToPath(new URL("../../.env", import.meta.url));
const systemPromptPath = fileURLToPath(new URL("../../EVERYTHING.md", import.meta.url));
const VALID_PROVIDERS = new Set<AgentProvider>(["anthropic", "openai-compatible"]);
const DEFAULT_TIMEOUT_MS = 60_000;
const CONFIG_KEYS = [
  "EVERYTHING_PROVIDER",
  "EVERYTHING_MODEL",
  "EVERYTHING_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;

interface RuntimeSettings {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  apiKey: string;
  keyName: "ANTHROPIC_API_KEY" | "OPENAI_API_KEY";
}

/** 可安全发送到浏览器的本地 Agent 配置。 */
export interface PublicAgentSettings {
  provider: AgentProvider;
  model: string;
  baseUrl: string;
  keyConfigured: boolean;
  keyLast4: string;
}

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
  return {
    workflow: toWorkflow(),
    settings: publicSettings(settings),
    systemPrompt: await readSystemPrompt(),
  };
}

/** 保存模型配置；密钥永远不会出现在返回值中。 */
export async function saveAgentSettings(body: Record<string, unknown>): Promise<{
  settings: PublicAgentSettings;
  models: string[];
}> {
  const provider = parseProvider(body.provider);
  const model = requiredText(body.model, "Model", 200);
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
    EVERYTHING_BASE_URL: effectiveBaseUrl,
  };
  if (apiKey) updates[keyName] = apiKey;
  await updateEnvFile(updates, clearApiKey ? [keyName] : []);
  const settings = await loadRuntimeSettings();
  return { settings: publicSettings(settings), models };
}

/** 显式保存根目录 EVERYTHING.md，并让下一回合立即读取新内容。 */
export async function saveSystemPrompt(body: Record<string, unknown>): Promise<string> {
  const systemPrompt = requiredText(body.systemPrompt, "System Prompt", 100_000);
  await atomicWrite(systemPromptPath, `${systemPrompt.trimEnd()}\n`, 0o644);
  return systemPrompt.trimEnd();
}

/** 执行一次真实 Agent 回合，并通过 observer 流式暴露脱敏事件。 */
export async function runLocalAgent(
  body: Record<string, unknown>,
  observer: AgentObserver,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const prompt = requiredText(body.prompt, "User Prompt", 40_000);
  const history = parseHistory(body.history);
  const settings = await loadRuntimeSettings();
  if (!settings.apiKey) throw new Error(`请先在配置页填写 ${settings.keyName}`);
  if (!settings.model) throw new Error("请先在配置页填写 Model");

  const messages: AgentMessage[] = [
    ...history.map((message) => ({ ...message })),
    { role: "user", content: prompt },
  ];
  const startedAt = performance.now();
  const result = await runAgentLoop({
    client: createModelClient(settings),
    model: settings.model,
    system: await readSystemPrompt(),
    messages,
    tools: new LocalToolRegistry(),
    maxIterations: 10,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    stream: true,
    signal,
    observer,
    serializeToolEvent: publicToolEvent,
  });
  return {
    reply: result.reply,
    iterations: result.iterations,
    stopReason: result.stopReason,
    toolCallCount: result.toolCalls.length,
    model: settings.model,
    provider: settings.provider,
    ms: Math.round(performance.now() - startedAt),
  };
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
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await rename(temporary, path);
}

async function readSystemPrompt(): Promise<string> {
  return readFile(systemPromptPath, "utf8");
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
  let summary = call.isError ? "工具执行失败" : "工具执行完成";
  if (call.tool === "get_current_time" && !call.isError) {
    try {
      const output = JSON.parse(call.output) as { local?: string; timeZone?: string };
      summary = [output.local, output.timeZone].filter(Boolean).join(" · ");
    } catch {
      summary = "已读取当前时间";
    }
  }
  return {
    tool: call.tool,
    toolUseId: call.toolUseId,
    iteration: call.iteration,
    isError: call.isError,
    summary,
  };
}

function parseHistory(value: unknown): AgentMessage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 50) throw new TypeError("Client Chat History 最多包含 50 条消息");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new TypeError(`Client Chat History 第 ${index + 1} 条消息无效`);
    }
    const record = item as Record<string, unknown>;
    if (record.role !== "user" && record.role !== "assistant") {
      throw new TypeError(`Client Chat History 第 ${index + 1} 条 role 无效`);
    }
    return {
      role: record.role,
      content: requiredText(record.content, `Client Chat History 第 ${index + 1} 条 content`, 40_000),
    };
  });
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
    baseUrl: settings.baseUrl,
    keyConfigured: Boolean(settings.apiKey),
    keyLast4: settings.apiKey ? settings.apiKey.slice(-4) : "",
  };
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
