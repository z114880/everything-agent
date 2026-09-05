import type { AgentMessage } from "../../agent-loop/agent-loop.ts";
import type { ChatLogEntry, ConsolidationRun, SemanticMemory, SessionSummary } from "../types.ts";

export interface Row extends Record<string, unknown> {}

/** 生成数据库使用的秒级 UTC 时间。 */
export function nowUtc(): string { return new Date().toISOString().replace(/\.\d{3}Z$/, "Z") }

/** 解析持久化 JSON；格式损坏时向调用方抛错。 */
export function parseJson(value: string): unknown { return JSON.parse(value) as unknown }

/** 清理事实文本；空内容抛出 TypeError。 */
export function requiredMemoryText(value: string, field: string): string {
  const clean = value.trim(); if (!clean) throw new TypeError(`${field} 不能为空`); return clean;
}

/** 区分最终回复和工具消息，决定是否进入检索投影。 */
export function messageKind(message: AgentMessage): string {
  if (message.role === "assistant" && Array.isArray(message.content) && message.content.some((block: unknown) => isBlock(block, "tool_use"))) return "assistant_tool_call";
  if (message.role === "user" && Array.isArray(message.content) && message.content.some((block: unknown) => isBlock(block, "tool_result"))) return "tool_result";
  return message.role === "assistant" ? "assistant_message" : "user_message";
}

function isBlock(value: unknown, type: string): boolean { return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === type) }

/** 递归移除凭证字段，保留其他结构化消息内容。 */
export function removeCredentials(value: unknown, key = ""): unknown {
  if (/api[-_]?key|authorization|cookie|token|secret|password/i.test(key)) return "[凭证已移除]";
  if (Array.isArray(value)) return value.map((item) => removeCredentials(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, removeCredentials(entryValue, entryKey)]));
}

/** 提取文本块供检索使用，不展开工具载荷。 */
export function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((block) => isBlock(block, "text")).map((block) => String((block as { text?: unknown }).text ?? "")).join("");
}

/** 将会话聚合行转换为对外摘要。 */
export function sessionFromRow(row: Row): SessionSummary {
  return {
    id: String(row.id), title: String(row.title), messageCount: Number(row.message_count ?? 0),
    completedRunCount: Number(row.completed_run_count ?? 0), incompleteRunCount: Number(row.incomplete_run_count ?? 0),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), pendingMessages: Number(row.pending_messages ?? 0),
  };
}

/** 还原 Chat Log 记录；损坏的 JSON 不静默忽略。 */
export function chatFromRow(row: Row): ChatLogEntry {
  return {
    id: Number(row.id), sessionId: String(row.session_id), runId: String(row.run_id), role: String(row.role),
    kind: String(row.kind), content: parseJson(String(row.content_json)), createdAt: String(row.created_at),
  };
}

/** 将语义事实行转换为对外记录，保留可选检索分数。 */
export function semanticFromRow(row: Row): SemanticMemory {
  return {
    id: Number(row.id), subject: String(row.subject), content: String(row.content), source: String(row.source),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.score === undefined ? {} : { score: Number(row.score) }),
  };
}

/** 转换整理任务记录，保留错误类型和完成状态。 */
export function consolidationFromRow(row: Row): ConsolidationRun {
  return {
    id: Number(row.id), runId: String(row.run_id), sessionId: String(row.session_id), trigger: String(row.trigger),
    status: String(row.status), throughMessageId: Number(row.through_message_id), factsCreated: Number(row.facts_created),
    factsUpdated: Number(row.facts_updated), factsSkipped: Number(row.facts_skipped),
    errorType: row.error_type === null || row.error_type === undefined ? null : String(row.error_type),
    startedAt: String(row.started_at), completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}
