import type { MemoryRuntime } from "../memory/index.ts";

export const MANAGE_MEMORY_TOOL = "manage_memory";
export const manageMemorySchema = {
  name: MANAGE_MEMORY_TOOL,
  description: "搜索、创建、更新或删除稳定且跨会话有用的 Semantic Memory。过去对话请使用 session_search/session_read。删除前必须先请求确认令牌。",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "create", "update", "request_delete", "delete"] },
      query: { type: "string" }, id: { type: "integer", minimum: 1 }, subject: { type: "string" },
      content: { type: "string" },
      category: { type: "string", enum: ["user_attribute", "preference", "ongoing_project", "constraint", "commitment"] },
      stable: { type: "boolean" }, futureUseful: { type: "boolean" }, confirmation: { type: "string" },
    },
    required: ["action"], additionalProperties: false,
  },
};

/** 管理聊天侧 Semantic Memory，并在工具内部强制写入与删除权限。 */
export class ManageMemoryTool {
  private readonly confirmations = new Map<string, { id: number; expiresAt: number }>();
  private readonly memory: MemoryRuntime;
  constructor(memory: MemoryRuntime) { this.memory = memory }
  execute(value: unknown): unknown {
    const args = record(value); const action = text(args.action, "action");
    if (action === "search") return this.memory.searchSemantic(text(args.query, "query"), 20);
    if (action === "create") {
      validateDeclaration(args);
      return this.memory.createSemantic(text(args.subject, "subject"), text(args.content, "content"), "agent");
    }
    if (action === "update") {
      validateDeclaration(args);
      return this.memory.updateSemantic(idValue(args.id), text(args.subject, "subject"), text(args.content, "content"), "agent");
    }
    if (action === "request_delete") {
      const id = idValue(args.id); const token = crypto.randomUUID();
      this.confirmations.set(token, { id, expiresAt: Date.now() + 60_000 });
      return { confirmation: token, expiresInMs: 60_000, message: `确认删除 Semantic Memory #${id}` };
    }
    if (action === "delete") {
      const id = idValue(args.id); const token = text(args.confirmation, "confirmation"); const pending = this.confirmations.get(token);
      this.confirmations.delete(token);
      if (!pending || pending.id !== id || pending.expiresAt < Date.now()) throw new Error("删除确认无效或已过期");
      this.memory.deleteSemantic(id, "agent"); return { deleted: true, id };
    }
    throw new TypeError("未知的 memory action");
  }
}
function validateDeclaration(args: Record<string, unknown>): void {
  const allowed = new Set(["user_attribute", "preference", "ongoing_project", "constraint", "commitment"]);
  if (!allowed.has(text(args.category, "category"))) throw new TypeError("category 不属于允许的 Semantic Memory 范围");
  if (args.stable !== true || args.futureUseful !== true) throw new TypeError("Semantic Memory 必须明确声明 stable 和 futureUseful 为 true");
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("工具参数必须是对象");
  return value as Record<string, unknown>;
}
function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} 不能为空`);
  return value.trim();
}
function idValue(value: unknown): number {
  const id = Number(value); if (!Number.isInteger(id) || id < 1) throw new TypeError("id 必须是正整数"); return id;
}
