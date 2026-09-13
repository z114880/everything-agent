import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { RUNTIME_DEFAULTS } from "./configuration/schema.ts";

const DEFAULT_SYSTEM_PROMPT = "你是用户的个人助理。使用中文清晰地回答，结合会话上下文和可用工具完成任务。不要编造事实或工具执行结果；缺少必要信息时向用户说明。\n";

const CONFIG_PATHS = {
  EVERYTHING_AGENT_PROVIDER: ["models", "agent", "provider"],
  EVERYTHING_AGENT_MODEL: ["models", "agent", "model"],
  EVERYTHING_AGENT_BASE_URL: ["models", "agent", "baseUrl"],
  EVERYTHING_SMALL_PROVIDER: ["models", "small", "provider"],
  EVERYTHING_SMALL_MODEL: ["models", "small", "model"],
  EVERYTHING_SMALL_BASE_URL: ["models", "small", "baseUrl"],
  EVERYTHING_SESSION_SEARCH_WINDOW: ["sessionRecall", "searchWindow"],
  EVERYTHING_SESSION_RECALL_ENTRY_TOKEN_LIMIT: ["sessionRecall", "entryTokenLimit"],
  EVERYTHING_AGENT_MAX_TOKENS: ["maxTokens"],
  EVERYTHING_AGENT_MAX_ITERATIONS: ["maxIterations"],
  EVERYTHING_MODEL_CONTEXT_WINDOW: ["modelContextWindow"],
  EVERYTHING_RETRIEVAL_MODE: ["retrieval", "mode"],
  EVERYTHING_EMBEDDING_BASE_URL: ["retrieval", "embedding", "baseUrl"],
  EVERYTHING_EMBEDDING_MODEL: ["retrieval", "embedding", "model"],
  EVERYTHING_EMBEDDING_QUERY_TEMPLATE: ["retrieval", "embedding", "queryTemplate"],
  EVERYTHING_EMBEDDING_DOCUMENT_TEMPLATE: ["retrieval", "embedding", "documentTemplate"],
  EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY: ["retrieval", "embedding", "minimumSimilarity"],
  EVERYTHING_TOOL_GET_CURRENT_TIME_ENABLED: ["tools", "getCurrentTimeEnabled"],
  EVERYTHING_TOOL_SEARCH_WEB_ENABLED: ["tools", "searchWebEnabled"],
} as const;

const SECRET_KEYS = [
  "EVERYTHING_AGENT_API_KEY",
  "EVERYTHING_SMALL_API_KEY",
  "EVERYTHING_EMBEDDING_API_KEY",
  "TAVILY_API_KEY",
] as const;
const CONFIG_KEYS = [...Object.keys(CONFIG_PATHS), ...SECRET_KEYS];
const NUMBER_CONFIG_KEYS = new Set([
  "EVERYTHING_SESSION_SEARCH_WINDOW",
  "EVERYTHING_SESSION_RECALL_ENTRY_TOKEN_LIMIT",
  "EVERYTHING_AGENT_MAX_TOKENS",
  "EVERYTHING_AGENT_MAX_ITERATIONS",
  "EVERYTHING_MODEL_CONTEXT_WINDOW",
  "EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY",
]);
const BOOLEAN_CONFIG_KEYS = new Set([
  "EVERYTHING_TOOL_GET_CURRENT_TIME_ENABLED",
  "EVERYTHING_TOOL_SEARCH_WEB_ENABLED",
]);

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
interface JsonObject { [key: string]: JsonValue }

const DEFAULT_CONFIG: JsonObject = {
  models: { agent: {}, small: {} },
  sessionRecall: {
    searchWindow: RUNTIME_DEFAULTS.sessionSearchWindow,
    entryTokenLimit: RUNTIME_DEFAULTS.sessionRecallEntryTokenLimit,
  },
  maxTokens: RUNTIME_DEFAULTS.maxTokens,
  maxIterations: RUNTIME_DEFAULTS.maxIterations,
  modelContextWindow: RUNTIME_DEFAULTS.modelContextWindow,
  retrieval: { mode: "lexical_only", embedding: {} },
  tools: { getCurrentTimeEnabled: true, searchWebEnabled: false },
};

/** 本地文件位置；配置与密钥固定保存到 `home/config.json` 与 `home/.env`。 */
export interface LocalConfigPaths {
  home: string;
  defaultSystemPromptPath: string;
}

/** 创建本地配置实例，将普通设置与密钥分别持久化。 */
export function createLocalConfig(paths: LocalConfigPaths) {
  const configPath = join(paths.home, "config.json");
  const envPath = join(paths.home, ".env");
  const systemPromptPath = join(paths.home, "EVERYTHING.md");
  return {
    initialize,
    readValues,
    updateConfigFile,
    updateSecretEnvFile,
    readSystemPrompt,
    saveSystemPrompt: (value: string) => atomicWrite(systemPromptPath, `${value.trimEnd()}\n`, 0o644),
  };

  /** 初始化运行所需的目录、默认配置、系统提示词和 Skills 目录。 */
  async function initialize(): Promise<void> {
    await mkdir(paths.home, { recursive: true });
    await mkdir(join(paths.home, "skills"), { recursive: true });
    await writeIfMissing(configPath, serializeConfig(DEFAULT_CONFIG), 0o600);
    // 注释占位不覆盖进程环境中已配置的密钥。
    await writeIfMissing(envPath, `# API Key 可在 Web 配置页面保存；请勿提交此文件。\n${SECRET_KEYS.map((key) => `# ${key}=`).join("\n")}\n`, 0o600);
    await readSystemPrompt();
  }

  /** 合并允许的进程变量、本地 JSON 设置和 `.everything/.env` 密钥文件。 */
  async function readValues(): Promise<Record<string, string>> {
    const inherited = Object.fromEntries(CONFIG_KEYS.flatMap((key) => process.env[key] === undefined
      ? []
      : [[key, process.env[key]!]]));
    const config = await readConfigIfPresent(configPath);
    const secrets = await readSecretsIfPresent(envPath);
    return { ...inherited, ...flattenConfig(config), ...secrets };
  }

  /** 原子更新 `.everything/config.json` 中的普通设置。 */
  async function updateConfigFile(updates: Record<string, string>): Promise<void> {
    const document = await readConfigIfPresent(configPath);
    for (const [key, value] of Object.entries(updates)) {
      const path = CONFIG_PATHS[key as keyof typeof CONFIG_PATHS];
      if (!path) throw new TypeError(`不允许写入未知配置：${key}`);
      setPath(document, path, decodeConfigValue(key, value));
    }
    await atomicWrite(configPath, serializeConfig(document));
  }

  /** 原子更新 `.everything/.env`，并确保其中只包含允许的密钥字段。 */
  async function updateSecretEnvFile(updates: Record<string, string>, clears: readonly string[]): Promise<void> {
    const current = await readSecretsIfPresent(envPath);
    for (const key of clears) assertSecretKey(key);
    for (const key of Object.keys(updates)) assertSecretKey(key);
    const next = { ...current, ...Object.fromEntries(clears.map((key) => [key, ""])), ...updates };
    const lines = SECRET_KEYS.filter((key) => Object.hasOwn(next, key)).map((key) => `${key}=${encodeEnvValue(next[key]!)}`);
    await atomicWrite(envPath, `${lines.join("\n")}${lines.length ? "\n" : ""}`);
  }

  async function readSystemPrompt(): Promise<string> {
    try {
      return await readFile(systemPromptPath, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      let initial: string;
      try {
        initial = await readFile(paths.defaultSystemPromptPath, "utf8");
      } catch (templateError) {
        if (!isMissingFile(templateError)) throw templateError;
        initial = DEFAULT_SYSTEM_PROMPT;
      }
      await mkdir(paths.home, { recursive: true });
      // 并发初始化只创建缺失文件，不覆盖其他调用方刚保存的提示词。
      await writeIfMissing(systemPromptPath, initial, 0o644);
      return readFile(systemPromptPath, "utf8");
    }
  }
}

function flattenConfig(document: JsonObject): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, path] of Object.entries(CONFIG_PATHS)) {
    const value = getPath(document, path);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = String(value);
  }
  return result;
}

function getPath(document: JsonObject, path: readonly string[]): JsonValue | undefined {
  let current: JsonValue = document;
  for (const segment of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment]!;
  }
  return current;
}

function setPath(document: JsonObject, path: readonly string[], value: JsonValue): void {
  let current = document;
  for (const segment of path.slice(0, -1)) {
    const child = current[segment];
    if (!isJsonObject(child)) current[segment] = {};
    current = current[segment] as JsonObject;
  }
  current[path.at(-1)!] = value;
}

function decodeConfigValue(key: string, value: string): string | number | boolean {
  if (BOOLEAN_CONFIG_KEYS.has(key)) {
    if (value !== "true" && value !== "false") throw new TypeError(`${key} 必须是布尔值`);
    return value === "true";
  }
  if (NUMBER_CONFIG_KEYS.has(key)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new TypeError(`${key} 必须是数字`);
    return number;
  }
  return value;
}

async function readConfigIfPresent(path: string): Promise<JsonObject> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isJsonObject(parsed)) throw new TypeError("本地配置必须是 JSON 对象");
    return parsed;
  } catch (error) {
    if (isMissingFile(error)) return structuredClone(DEFAULT_CONFIG);
    if (error instanceof SyntaxError) throw new TypeError(`本地配置 JSON 无效：${error.message}`, { cause: error });
    throw error;
  }
}

async function readSecretsIfPresent(path: string): Promise<Record<string, string>> {
  try {
    const parsed = parseEnv(await readFile(path, "utf8"));
    return Object.fromEntries(SECRET_KEYS.flatMap((key) => Object.hasOwn(parsed, key) ? [[key, parsed[key]!]] : []));
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw error;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function serializeConfig(document: JsonObject): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function assertSecretKey(key: string): void {
  if (!(SECRET_KEYS as readonly string[]).includes(key)) throw new TypeError(`不允许把非密钥配置写入 .env：${key}`);
}

async function writeIfMissing(path: string, contents: string, mode: number): Promise<void> {
  try {
    await writeFile(path, contents, { encoding: "utf8", mode, flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
  }
}

async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, contents, { encoding: "utf8", mode });
  await rename(temporary, path);
}

/** 解析 dotenv 的常见 KEY=VALUE 语法，仅用于 `.everything/.env` 密钥文件。 */
export function parseEnv(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    values[match[1]!] = decodeEnvValue(match[2] ?? "");
  }
  return values;
}

/** 更新 dotenv 文本；公开保留给密钥文件测试和调用方。 */
export function updateEnvText(text: string, updates: Record<string, string>, clears: readonly string[] = []): string {
  const remaining = new Map(Object.entries(updates));
  const clearSet = new Set(clears);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || (!Object.hasOwn(updates, key) && !clearSet.has(key))) {
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

function decodeEnvValue(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; }
    catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, "").trim();
}

function encodeEnvValue(value: string): string {
  return JSON.stringify(value);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "EEXIST");
}
