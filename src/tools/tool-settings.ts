import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { detectSandbox } from "../sandbox/index.ts";
import type { createLocalConfig } from "../agent-runtime/local-config.ts";
import { readSkillSchema } from "../skills/index.ts";
import { manageMemorySchema } from "./manage-memory.ts";
import { sessionReadSchema, sessionSearchSchema } from "./session-recall.ts";
import { searchWebSchema } from "./tavily-search.ts";
import { runTerminalSchema } from "./terminal.ts";
import { timeToolSchema } from "./tool-registry.ts";

export interface ToolSettings {
  getCurrentTimeEnabled: boolean;
  searchWebEnabled: boolean;
  tavilyApiKey: string;
  terminalEnabled: boolean;
  terminalWorkspaceRoot: string;
}

export interface ToolSettingsInput {
  getCurrentTimeEnabled: boolean;
  searchWebEnabled: boolean;
  tavilyApiKey?: string;
  clearTavilyApiKey?: boolean;
  terminalEnabled?: boolean;
  terminalWorkspaceRoot?: string;
}

export interface PublicToolDescriptor {
  name: string;
  description: string;
  origin: "内置" | "Tavily";
  enabled: boolean;
  configurable: boolean;
  configured: boolean;
  configurationLabel?: string;
}

/** 管理工具启用状态与外部工具凭证，只有凭证写入 `.everything/.env`。 */
export function createToolSettings(config: ReturnType<typeof createLocalConfig>) {
  return { load, save, publicCatalog };

  async function load(): Promise<ToolSettings> {
    const values = await config.readValues();
    return {
      getCurrentTimeEnabled: parseBoolean(values.EVERYTHING_TOOL_GET_CURRENT_TIME_ENABLED, true),
      searchWebEnabled: parseBoolean(values.EVERYTHING_TOOL_SEARCH_WEB_ENABLED, false),
      tavilyApiKey: values.TAVILY_API_KEY ?? "",
      terminalEnabled: parseBoolean(values.EVERYTHING_TOOL_RUN_TERMINAL_ENABLED, false),
      terminalWorkspaceRoot: values.EVERYTHING_TOOL_RUN_TERMINAL_WORKSPACE_ROOT ?? "",
    };
  }

  async function save(input: ToolSettingsInput): Promise<ToolSettings> {
    if (typeof input.getCurrentTimeEnabled !== "boolean" || typeof input.searchWebEnabled !== "boolean") {
      throw new TypeError("工具启用状态必须是布尔值");
    }
    const before = await load();
    const inputApiKey = optionalSecret(input.tavilyApiKey);
    const clearApiKey = input.clearTavilyApiKey === true;
    const candidateApiKey = clearApiKey ? "" : inputApiKey || before.tavilyApiKey;
    if (input.searchWebEnabled && !candidateApiKey) throw new TypeError("启用 search_web 前必须配置 Tavily API Key");

    const terminalEnabled = input.terminalEnabled ?? before.terminalEnabled;
    const terminalWorkspaceRoot = normalizeWorkspaceRoot(input.terminalWorkspaceRoot ?? before.terminalWorkspaceRoot);
    if (terminalEnabled) assertTerminalUsable(terminalWorkspaceRoot);

    await config.updateConfigFile({
      EVERYTHING_TOOL_GET_CURRENT_TIME_ENABLED: String(input.getCurrentTimeEnabled),
      EVERYTHING_TOOL_SEARCH_WEB_ENABLED: String(input.searchWebEnabled && Boolean(candidateApiKey)),
      EVERYTHING_TOOL_RUN_TERMINAL_ENABLED: String(terminalEnabled),
      EVERYTHING_TOOL_RUN_TERMINAL_WORKSPACE_ROOT: terminalWorkspaceRoot,
    });
    await config.updateSecretEnvFile(inputApiKey ? { TAVILY_API_KEY: inputApiKey } : {}, clearApiKey ? ["TAVILY_API_KEY"] : []);
    return load();
  }

  async function publicCatalog(): Promise<{
    tools: PublicToolDescriptor[];
    tavily: { keyConfigured: boolean; keyLast4: string };
    terminal: { sandboxKind: string | null; unavailableReason: string | null; workspaceRoot: string };
  }> {
    const settings = await load();
    const availability = detectSandbox();
    return {
      tools: [
        fixedTool(manageMemorySchema),
        fixedTool(sessionSearchSchema),
        fixedTool(sessionReadSchema),
        fixedTool(readSkillSchema),
        {
          name: timeToolSchema.name, description: timeToolSchema.description,
          origin: "内置", enabled: settings.getCurrentTimeEnabled, configurable: true, configured: true,
        },
        {
          name: searchWebSchema.name, description: searchWebSchema.description,
          origin: "Tavily", enabled: settings.searchWebEnabled, configurable: true,
          configured: Boolean(settings.tavilyApiKey), configurationLabel: "Tavily API Key",
        },
        {
          name: runTerminalSchema.name, description: runTerminalSchema.description,
          origin: "内置",
          // 沙箱不可用时该工具不会注册，界面据此显示为不可用而不是已启用。
          enabled: settings.terminalEnabled && availability.available,
          configurable: true,
          configured: Boolean(settings.terminalWorkspaceRoot) && availability.available,
          configurationLabel: "工作区根目录",
        },
      ],
      tavily: {
        keyConfigured: Boolean(settings.tavilyApiKey),
        keyLast4: settings.tavilyApiKey ? settings.tavilyApiKey.slice(-4) : "",
      },
      terminal: {
        sandboxKind: availability.available ? availability.kind : null,
        unavailableReason: availability.available ? null : availability.reason,
        workspaceRoot: settings.terminalWorkspaceRoot,
      },
    };
  }
}

function fixedTool(schema: { name: string; description: string }): PublicToolDescriptor {
  return { name: schema.name, description: schema.description, origin: "内置", enabled: true, configurable: false, configured: true };
}

/** 工作区根必须是绝对路径；空值表示尚未配置。 */
function normalizeWorkspaceRoot(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > 4_000) throw new TypeError("工作区根目录必须是小于 4000 字符的字符串");
  const trimmed = value.trim();
  if (trimmed === "") return "";
  if (!isAbsolute(trimmed)) throw new TypeError("工作区根目录必须是绝对路径");
  return resolve(trimmed);
}

/** 启用终端工具前，工作区必须存在且当前平台确实能建立沙箱。 */
function assertTerminalUsable(workspaceRoot: string): void {
  if (!workspaceRoot) throw new TypeError("启用 run_terminal 前必须配置工作区根目录");
  let isDirectory = false;
  try {
    isDirectory = statSync(workspaceRoot).isDirectory();
  } catch {
    throw new TypeError(`工作区根目录不存在：${workspaceRoot}`);
  }
  if (!isDirectory) throw new TypeError(`工作区根目录必须是目录：${workspaceRoot}`);
  const availability = detectSandbox();
  if (!availability.available) throw new TypeError(`无法启用 run_terminal：${availability.reason}`);
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new TypeError(`工具开关必须是 true 或 false，当前值为 ${value}`);
}

function optionalSecret(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 10_000) throw new TypeError("Tavily API Key 必须是小于 10000 字符的字符串");
  return value.trim();
}
