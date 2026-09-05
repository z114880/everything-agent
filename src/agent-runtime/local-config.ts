import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
const CONFIG_KEYS = [
  "EVERYTHING_PROVIDER",
  "EVERYTHING_MODEL",
  "EVERYTHING_SMALL_MODEL",
  "EVERYTHING_SESSION_SEARCH_WINDOW",
  "EVERYTHING_SESSION_SCROLL_STEP",
  "EVERYTHING_SESSION_RECALL_MESSAGE_LIMIT",
  "EVERYTHING_SESSION_RECALL_TOKEN_LIMIT",
  "EVERYTHING_MODEL_CONTEXT_WINDOW",
  "EVERYTHING_RETRIEVAL_MODE",
  "EVERYTHING_EMBEDDING_BASE_URL",
  "EVERYTHING_EMBEDDING_MODEL",
  "EVERYTHING_EMBEDDING_QUERY_TEMPLATE",
  "EVERYTHING_EMBEDDING_DOCUMENT_TEMPLATE",
  "EVERYTHING_EMBEDDING_MINIMUM_SIMILARITY",
  "EVERYTHING_EMBEDDING_API_KEY",
  "EVERYTHING_BASE_URL",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
] as const;
/** 本地配置文件的位置；由宿主入口显式指定。 */
export interface LocalConfigPaths {
  home: string;
  envPath: string;
  defaultSystemPromptPath: string;
}
/** 创建独立的本地配置读写实例，不修改进程环境。 */
export function createLocalConfig(paths: LocalConfigPaths) {
  const { envPath } = paths;
  const systemPromptPath = join(paths.home, "EVERYTHING.md");
  const legacySystemPromptPath = paths.defaultSystemPromptPath;
  return { readEnvValues, updateEnvFile, readSystemPrompt,
    saveSystemPrompt: (value: string) => atomicWrite(systemPromptPath, `${value.trimEnd()}\n`, 0o644) };
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
    await atomicWrite(envPath, updateEnvText(current, { ...Object.fromEntries(clears.map((key) => [key, ""])), ...updates }));
  }

  async function atomicWrite(path: string, contents: string, mode = 0o600): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
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

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
