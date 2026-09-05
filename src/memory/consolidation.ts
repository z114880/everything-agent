import { SEMANTIC_MEMORY_CATEGORIES } from "./types.ts";
import type { ConsolidationRun, MemoryModelOptions } from "./types.ts";
import type { Row } from "./storage/records.ts";
import { nowUtc, parseJson, plainText, consolidationFromRow } from "./storage/records.ts";
import type { SemanticStore } from "./storage/semantic-store.ts";
import type { MemorySearch } from "./retrieve/memory-search.ts";
import type { MemoryDatabase } from "./storage/database.ts";
import type { SessionStore } from "./storage/session-store.ts";

/** 串行整理已完成回合，记录事实变更与高水位。 */
export class MemoryConsolidation {
  private readonly storage: MemoryDatabase;
  private readonly sessions: SessionStore;
  private readonly semantic: SemanticStore;
  private readonly search: MemorySearch;

  constructor(storage: MemoryDatabase, sessions: SessionStore, semantic: SemanticStore, search: MemorySearch) {
    this.storage = storage;
    this.sessions = sessions;
    this.semantic = semantic;
    this.search = search;
  }

  private consolidationQueue: Promise<void> = Promise.resolve();

  /** 将一个 Session 的增量 Semantic consolidation 加入单一后台队列。 */
  scheduleConsolidation(sessionId: string, trigger: "new_session" | "startup", options: MemoryModelOptions): void {
    this.consolidationQueue = this.consolidationQueue.then(() => this.consolidateSession(sessionId, trigger, options)).catch(() => undefined);
  }

  schedulePendingConsolidations(options: MemoryModelOptions): void {
    for (const session of this.sessions.listSessions().filter((item) => item.pendingMessages > 0)) this.scheduleConsolidation(session.id, "startup", options);
  }

  async waitForConsolidation(): Promise<void> { await this.consolidationQueue }

  listConsolidations(limit = 100): ConsolidationRun[] {
    return (this.storage.connection.prepare("SELECT * FROM consolidation_runs ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map(consolidationFromRow);
  }

  private async consolidateSession(sessionId: string, trigger: string, options: MemoryModelOptions): Promise<void> {
    const session = this.sessions.getSessionRow(sessionId); if (!session) return;
    const watermark = Number(session.consolidated_through_message_id);
    const rows = this.storage.connection.prepare(`
      SELECT c.* FROM chat_log c WHERE c.session_id = ? AND c.id > ?
        AND EXISTS (SELECT 1 FROM chat_log done WHERE done.session_id = c.session_id AND done.run_id = c.run_id AND done.kind = 'assistant_message')
      ORDER BY c.id
    `).all(sessionId, watermark) as Row[];
    if (!rows.length) return;
    const throughMessageId = Math.max(...rows.map((row) => Number(row.id)));
    const relevant = rows.filter((row) => row.kind === "user_message" || row.kind === "assistant_message");
    if (!relevant.length) return;
    const runId = crypto.randomUUID(); const startedAt = nowUtc();
    const insert = this.storage.connection.prepare(`
      INSERT INTO consolidation_runs(run_id, session_id, trigger, status, through_message_id, started_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(runId, sessionId, trigger, throughMessageId, startedAt);
    const consolidationId = Number(insert.lastInsertRowid); const observer = options.observer ?? (() => {});
    await observer("consolidation_start", { runId, sessionId, trigger, throughMessageId });
    try {
      const transcript = relevant.map((row) => `${row.role}: ${plainText(parseJson(String(row.content_json)))}`).join("\n");
      const candidates = await this.search.searchSemantic(transcript.slice(0, 5_000), 12, undefined, runId);
      const response = await options.client.messages.create({
        model: options.model, system: consolidationSystemPrompt(),
        messages: [{ role: "user", content: `Related Facts:\n${candidates.map((item) => `#${item.id} ${item.subject}: ${item.content}`).join("\n") || "（无）"}\n\nNew Dialogue:\n${transcript}` }],
        tools: [], max_tokens: 4096, signal: undefined,
      });
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const facts = parseConsolidation(text); let factsCreated = 0; let factsUpdated = 0; let factsSkipped = 0;
      for (const fact of facts) {
        if (!isDurableSemanticFact(fact)) factsSkipped += 1;
        else if (fact.action === "create" && fact.subject && fact.content) {
          await this.semantic.createSemantic(fact.subject, fact.content, "consolidation"); factsCreated += 1;
        } else if (fact.action === "update" && fact.id && fact.subject && fact.content && this.semantic.getSemantic(fact.id)) {
          await this.semantic.updateSemantic(fact.id, fact.subject, fact.content, "consolidation"); factsUpdated += 1;
        } else factsSkipped += 1;
      }
      this.storage.transaction(() => {
        this.storage.connection.prepare("UPDATE sessions SET consolidated_through_message_id = ? WHERE id = ?").run(throughMessageId, sessionId);
        this.storage.connection.prepare(`
          UPDATE consolidation_runs SET status='completed', facts_created=?, facts_updated=?, facts_skipped=?, completed_at=? WHERE id=?
        `).run(factsCreated, factsUpdated, factsSkipped, nowUtc(), consolidationId);
      });
      await observer("consolidation_end", { runId, sessionId, throughMessageId, factsCreated, factsUpdated, factsSkipped });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      this.storage.connection.prepare("UPDATE consolidation_runs SET status='failed', error_type=?, completed_at=? WHERE id=?")
        .run(errorType, nowUtc(), consolidationId);
      await observer("consolidation_error", { runId, sessionId, throughMessageId, errorType }); throw error;
    }
  }
}

const SEMANTIC_FACT_CATEGORIES = new Set<string>(SEMANTIC_MEMORY_CATEGORIES);

function consolidationSystemPrompt(): string {
  return `你负责把个人助理 Session 的新增对话整理为 Semantic Memory。记忆必须保持原对话语言。
只保存跨 Session 仍有用、预计长期成立且与用户直接相关的稳定属性、偏好、持续项目事实、约束或承诺。不得保存临时结果、通用知识、寒暄、凭证或未经支持的推断。
对照已有事实，只输出 create、update 或 noop；create/update 必须提供允许的 category，且 stable 和 futureUseful 都为 true。update 必须引用已有整数 ID。
只输出 JSON：{"facts":[{"action":"create|update|noop","id":1,"category":"user_attribute|preference|ongoing_project|constraint|commitment","stable":true,"futureUseful":true,"subject":"主题","content":"事实"}]}`;
}

interface DistilledFact {
  action: string; id?: number; category?: string; stable?: boolean; futureUseful?: boolean; subject?: string; content?: string;
}

function parseConsolidation(text: string): DistilledFact[] {
  const start = text.indexOf("{"); const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TypeError("Consolidation 未返回 JSON");
  const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const facts = Array.isArray(value.facts) ? value.facts.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  return facts.map((item) => ({
    action: String(item.action ?? "noop"), ...(typeof item.id === "number" ? { id: item.id } : {}),
    ...(typeof item.category === "string" ? { category: item.category } : {}),
    ...(typeof item.stable === "boolean" ? { stable: item.stable } : {}),
    ...(typeof item.futureUseful === "boolean" ? { futureUseful: item.futureUseful } : {}),
    ...(typeof item.subject === "string" ? { subject: item.subject } : {}),
    ...(typeof item.content === "string" ? { content: item.content } : {}),
  }));
}

function isDurableSemanticFact(fact: DistilledFact): boolean {
  if (fact.action === "noop") return true;
  return fact.stable === true && fact.futureUseful === true && typeof fact.category === "string" && SEMANTIC_FACT_CATEGORIES.has(fact.category);
}
