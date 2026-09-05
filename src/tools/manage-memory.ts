import type { MemoryManagementOptions, MemoryRuntime } from "../memory/index.ts";
import { readMemoryCandidate } from "../memory/index.ts";
import type { ToolExecutionContext } from "../agent-loop/agent-loop.ts";

export const MANAGE_MEMORY_TOOL = "manage_memory";
export const manageMemorySchema = {
  name: MANAGE_MEMORY_TOOL,
  description: "搜索长期记忆，或提交一个独立事实/明确忘记意图。submit 返回 queued 表示已接收，后台强制检索并由小模型判断新增、更新、删除、合并或跳过；不等待结果，不得声称已保存成功，不要自行指定操作或目标 ID。仅提交当前用户原文支持的信息；删除无需确认。历史对话使用 session_search/session_read。",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "submit"] },
      query: { type: "string" },
      intent: { type: "string", enum: ["remember", "forget"] },
      subject: { type: "string" }, attribute: { type: "string" }, content: { type: "string" },
    },
    required: ["action"], additionalProperties: false,
  },
};

/** 将当前回合的可信证据绑定在工具外部，主模型不能伪造证据 ID 或绕过检索写入。 */
export class ManageMemoryTool {
  private readonly memory: MemoryRuntime;
  private readonly options: (MemoryManagementOptions & { evidenceMessageId: number }) | undefined;

  constructor(memory: MemoryRuntime, options?: MemoryManagementOptions & { evidenceMessageId: number }) {
    this.memory = memory; this.options = options;
  }

  /** 提交落库后立即返回 queued；未绑定当前用户证据时仅允许搜索。 */
  execute(value: unknown, context?: ToolExecutionContext): unknown {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("参数必须是对象");
    const args = value as Record<string, unknown>;
    if (Object.keys(args).some((key) => !["action", "query", "intent", "subject", "attribute", "content"].includes(key))) throw new TypeError("不支持的记忆参数");
    if (args.action === "search") {
      if (typeof args.query !== "string" || !args.query.trim()) throw new TypeError("query 不能为空");
      return this.memory.searchSemantic(args.query, 20);
    }
    if (args.action !== "submit") throw new TypeError("未知的 memory action");
    if (!this.options) throw new Error("记忆提交缺少当前回合的模型与证据");
    const candidate = readMemoryCandidate({ ...args, evidenceMessageIds: [this.options.evidenceMessageId] });
    const signals = [this.options.signal, context?.signal].filter((signal): signal is AbortSignal => Boolean(signal));
    if (context?.deadline !== undefined && context.deadline !== null) {
      if (context.deadline <= Date.now()) throw new Error("记忆提交已超过回合截止时间");
      signals.push(AbortSignal.timeout(Math.ceil(context.deadline - Date.now())));
    }
    for (const signal of signals) signal.throwIfAborted();
    return this.memory.enqueueMemory(candidate, this.options);
  }
}
