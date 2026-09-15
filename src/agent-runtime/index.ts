export { createAgentRuntime } from "./agent-runtime.ts";
export { DAILY_CONSOLIDATION_HOUR, startDailyConsolidationCheck } from "./daily-consolidation.ts";
export type { DailyConsolidationCheck, DailyConsolidationCheckOptions } from "./daily-consolidation.ts";
export { AgentConfigError, RUNTIME_DEFAULTS } from "./configuration/schema.ts";
export type { AgentRuntime } from "./agent-runtime.ts";
export type {
  AgentSettingsInput, ModelConnectionInput, ModelConnectionSettings, ModelConnectionTarget,
  PublicAgentSettings, PublicModelConnection,
} from "./configuration/schema.ts";
export type { AgentRunInput, AgentRunOptions, AgentRunResult, AgentRuntimeOptions } from "./types.ts";
export { availableInputTokens, contextWaterline, CONTEXT_SAFETY_TOKENS } from "./context-window.ts";
export type { ContextUsage, ContextWaterline } from "./context-window.ts";
export { createLocalConfig, parseEnv, updateEnvText } from "./local-config.ts";
export type { LocalConfigPaths } from "./local-config.ts";
export type { AgentSkill, SaveSkillInput } from "../skills/index.ts";
export type { PublicToolDescriptor, ToolSettings, ToolSettingsInput } from "../tools/tool-settings.ts";
export { SEARCH_WEB_TOOL, TavilySearchTool, searchWebSchema } from "../tools/tavily-search.ts";
export { clearEverythingData } from "./local-data.ts";

/** 受控宿主接口协议；评估器只运行显式支持环境注入的源码版本。 */
export const AGENT_RUNTIME_HOST_PROTOCOL = 1;
