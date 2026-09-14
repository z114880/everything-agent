import type {
  AgentObserver,
  ToolExecutionContext,
  ToolRegistry,
} from "../agent-loop/agent-loop.ts";
import type { MemoryRuntime } from "../memory/index.ts";
import { READ_SKILL_TOOL, ReadSkillTool, readSkillSchema, type SkillStore } from "../skills/index.ts";
import { MANAGE_MEMORY_TOOL, ManageMemoryTool, manageMemorySchema } from "./manage-memory.ts";
import {
  SESSION_READ_TOOL,
  SESSION_SEARCH_TOOL,
  SessionRecallTools,
  sessionReadSchema,
  sessionSearchSchema,
} from "./session-recall.ts";
import { SEARCH_WEB_TOOL, TavilySearchTool, searchWebSchema } from "./tavily-search.ts";
import { RUN_TERMINAL_TOOL, TerminalTool, runTerminalSchema } from "./terminal.ts";
import type { ApprovalGate } from "./approval.ts";

export const TIME_TOOL = "get_current_time";
export const timeToolSchema = {
  name: TIME_TOOL,
  description: "读取 Agent 所在服务器的当前日期、时间和时区。需要回答当前时间时必须调用此工具。",
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

export interface LocalToolOptions {
  getCurrentTimeEnabled?: boolean;
  searchWebEnabled?: boolean;
  tavilyApiKey?: string;
  terminalEnabled?: boolean;
  /** 终端工具的工作区根，启用时必填。 */
  terminalWorkspaceRoot?: string;
  /** 终端工具可写的临时目录，同时作为子进程 TMPDIR。 */
  terminalSessionTempDir?: string;
  /** 人工审批通道；缺省时需要审批的命令一律拒绝执行。 */
  approval?: ApprovalGate;
}

/** 注册本地受控工具，并在执行前统一检查取消信号和参数。 */
export class LocalToolRegistry implements ToolRegistry {
  private readonly manageMemory: ManageMemoryTool | null;
  private readonly sessionRecall: SessionRecallTools | null;
  private readonly readSkill: ReadSkillTool | null;
  private readonly options: Required<Omit<LocalToolOptions, "approval">> & { approval: ApprovalGate | null };
  private readonly tavilySearch: TavilySearchTool | null;
  private readonly terminal: TerminalTool | null;
  /** 终端工具未注册的原因，供上层解释为何模型看不到该能力。 */
  readonly terminalUnavailableReason: string | null;

  constructor(
    memory?: MemoryRuntime,
    manageMemory?: ManageMemoryTool,
    recall?: { currentSessionId: string; settings: import("../memory/index.ts").SessionRecallSettings },
    skills?: SkillStore,
    options: LocalToolOptions = {},
  ) {
    this.manageMemory = manageMemory ?? (memory ? new ManageMemoryTool(memory) : null);
    this.sessionRecall = memory && recall ? new SessionRecallTools(memory, recall.currentSessionId, recall.settings) : null;
    this.readSkill = skills ? new ReadSkillTool(skills) : null;
    this.options = {
      getCurrentTimeEnabled: options.getCurrentTimeEnabled ?? true,
      searchWebEnabled: options.searchWebEnabled ?? false,
      tavilyApiKey: options.tavilyApiKey ?? "",
      terminalEnabled: options.terminalEnabled ?? false,
      terminalWorkspaceRoot: options.terminalWorkspaceRoot ?? "",
      terminalSessionTempDir: options.terminalSessionTempDir ?? "",
      approval: options.approval ?? null,
    };
    this.tavilySearch = this.options.searchWebEnabled && this.options.tavilyApiKey
      ? new TavilySearchTool(this.options.tavilyApiKey)
      : null;

    const terminal = this.createTerminal();
    this.terminal = terminal.tool;
    this.terminalUnavailableReason = terminal.reason;
  }

  /**
   * 构造终端工具。
   *
   * 沙箱不可用时返回原因而不是抛错，让其余工具照常工作；模型看不到这个工具，
   * 界面据 `terminalUnavailableReason` 说明缺失原因，不会静默降级为无保护执行。
   */
  private createTerminal(): { tool: TerminalTool | null; reason: string | null } {
    if (!this.options.terminalEnabled) return { tool: null, reason: null };
    if (!this.options.terminalWorkspaceRoot) return { tool: null, reason: "尚未配置工作区根目录" };
    try {
      return {
        tool: new TerminalTool({
          workspaceRoot: this.options.terminalWorkspaceRoot,
          sessionTempDir: this.options.terminalSessionTempDir || this.options.terminalWorkspaceRoot,
          ...(this.options.approval === null ? {} : { approval: this.options.approval }),
        }),
        reason: null,
      };
    } catch (error) {
      return { tool: null, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  schemas(): unknown {
    const schemas: unknown[] = [];
    if (this.options.getCurrentTimeEnabled) schemas.push(timeToolSchema);
    if (this.manageMemory) schemas.push(manageMemorySchema);
    if (this.sessionRecall) schemas.push(sessionSearchSchema, sessionReadSchema);
    if (this.readSkill) schemas.push(readSkillSchema);
    if (this.tavilySearch) schemas.push(searchWebSchema);
    if (this.terminal) schemas.push(runTerminalSchema);
    return schemas;
  }

  execute(
    name: string,
    args: unknown,
    notify: AgentObserver,
    context: ToolExecutionContext,
  ): unknown {
    if (context.signal?.aborted) throw context.signal.reason;
    if (name === MANAGE_MEMORY_TOOL && this.manageMemory) return this.manageMemory.execute(args, notify, context);
    if ((name === SESSION_SEARCH_TOOL || name === SESSION_READ_TOOL) && this.sessionRecall) {
      return this.sessionRecall.execute(name, args, notify);
    }
    if (name === READ_SKILL_TOOL && this.readSkill) return this.readSkill.execute(args, notify, context);
    if (name === SEARCH_WEB_TOOL && this.tavilySearch) return this.tavilySearch.execute(args, context);
    if (name === RUN_TERMINAL_TOOL && this.terminal) return this.terminal.execute(args, notify, context);
    if (name !== TIME_TOOL || !this.options.getCurrentTimeEnabled) throw new Error(`工具未注册：${name}`);
    if (!isEmptyObject(args)) throw new TypeError(`${TIME_TOOL} 不接受参数`);

    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return {
      iso: now.toISOString(),
      timeZone,
      local: new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now),
    };
  }
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}
