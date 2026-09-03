import type { MemoryRuntime } from "../memory/index.js";

const CONFIRMATION_TTL_MS = 10 * 60 * 1_000;

export const MANAGE_MEMORY_TOOL = "manage_memory";

export const manageMemorySchema = {
  name: MANAGE_MEMORY_TOOL,
  description: "搜索、创建、修正或删除长期记忆。Episodic memory 不能由此工具创建或修改；删除必须先取得确认令牌。",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["search", "create", "update", "delete"] },
      kind: { type: "string", enum: ["semantic", "episodic"] },
      query: { type: "string" },
      id: { type: "integer" },
      subject: { type: "string" },
      content: { type: "string" },
      confirmationId: { type: "string" },
    },
    required: ["action", "kind"],
    additionalProperties: false,
  },
};

interface PendingDelete {
  kind: "semantic" | "episodic";
  id: number;
  expiresAt: number;
}
/** 管理聊天侧记忆操作，并在工具内部强制 episodic 与删除权限。 */
export class ManageMemoryTool {
  private readonly pendingDeletes = new Map<string, PendingDelete>();

  constructor(private readonly memory: MemoryRuntime) {}

  execute(value: unknown): unknown {
    const input = objectInput(value);
    const action = text(input.action, "action");
    const kind = memoryKind(input.kind);

    if (action === "search") {
      const query = text(input.query, "query");
      return kind === "semantic"
        ? this.memory.searchSemantic(query, 10)
        : this.memory.searchEpisodic(query, 10);
    }
    if (action === "create") {
      if (kind !== "semantic") throw new Error("Episodic memory 只能由 Session consolidation 或用户界面创建");
      return this.memory.createSemantic(text(input.subject, "subject"), text(input.content, "content"), "user");
    }
    if (action === "update") {
      if (kind !== "semantic") throw new Error("Episodic memory 不能由普通工具调用修改");
      return this.memory.updateSemantic(integer(input.id, "id"), text(input.subject, "subject"), text(input.content, "content"), "user");
    }
    if (action === "delete") return this.delete(kind, integer(input.id, "id"), input.confirmationId);
    throw new TypeError("manage_memory action 无效");
  }

  private delete(kind: "semantic" | "episodic", id: number, confirmationValue: unknown): unknown {
    this.removeExpiredConfirmations();
    if (typeof confirmationValue !== "string" || !confirmationValue) {
      const target = kind === "semantic"
        ? this.memory.listSemantic().find((item) => item.id === id)
        : this.memory.listEpisodic().find((item) => item.id === id);
      if (!target) throw new Error("待删除的记忆不存在");
      const confirmationId = crypto.randomUUID();
      this.pendingDeletes.set(confirmationId, { kind, id, expiresAt: Date.now() + CONFIRMATION_TTL_MS });
      return { requiresConfirmation: true, confirmationId, kind, id, target };
    }
    const pending = this.pendingDeletes.get(confirmationValue);
    if (!pending || pending.kind !== kind || pending.id !== id) throw new Error("删除确认无效或已过期");
    this.pendingDeletes.delete(confirmationValue);
    if (kind === "semantic") this.memory.deleteSemantic(id, "user");
    else this.memory.deleteEpisodic(id, "user");
    return { deleted: true, kind, id };
  }

  private removeExpiredConfirmations(): void {
    const now = Date.now();
    for (const [id, pending] of this.pendingDeletes) if (pending.expiresAt <= now) this.pendingDeletes.delete(id);
  }
}

function objectInput(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("manage_memory 参数必须是对象");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} 必须是非空字符串`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new TypeError(`${field} 必须是正整数`);
  return Number(value);
}

function memoryKind(value: unknown): "semantic" | "episodic" {
  if (value !== "semantic" && value !== "episodic") throw new TypeError("kind 必须是 semantic 或 episodic");
  return value;
}
