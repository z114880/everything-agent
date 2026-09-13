import type { createLocalConfig } from "../agent-runtime/local-config.ts";
import { readSkillSchema } from "../skills/index.ts";
import { manageMemorySchema } from "./manage-memory.ts";
import { sessionReadSchema, sessionSearchSchema } from "./session-recall.ts";
import { searchWebSchema } from "./tavily-search.ts";
import { timeToolSchema } from "./tool-registry.ts";

export interface ToolSettings {
  getCurrentTimeEnabled: boolean;
  searchWebEnabled: boolean;
  tavilyApiKey: string;
}

export interface ToolSettingsInput {
  getCurrentTimeEnabled: boolean;
  searchWebEnabled: boolean;
  tavilyApiKey?: string;
  clearTavilyApiKey?: boolean;
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
    await config.updateConfigFile({
      EVERYTHING_TOOL_GET_CURRENT_TIME_ENABLED: String(input.getCurrentTimeEnabled),
      EVERYTHING_TOOL_SEARCH_WEB_ENABLED: String(input.searchWebEnabled && Boolean(candidateApiKey)),
    });
    await config.updateSecretEnvFile(inputApiKey ? { TAVILY_API_KEY: inputApiKey } : {}, clearApiKey ? ["TAVILY_API_KEY"] : []);
    return load();
  }

  async function publicCatalog(): Promise<{ tools: PublicToolDescriptor[]; tavily: { keyConfigured: boolean; keyLast4: string } }> {
    const settings = await load();
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
      ],
      tavily: {
        keyConfigured: Boolean(settings.tavilyApiKey),
        keyLast4: settings.tavilyApiKey ? settings.tavilyApiKey.slice(-4) : "",
      },
    };
  }
}

function fixedTool(schema: { name: string; description: string }): PublicToolDescriptor {
  return { name: schema.name, description: schema.description, origin: "内置", enabled: true, configurable: false, configured: true };
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
