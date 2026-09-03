import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentMessage, AgentObserver } from "../agent-loop/agent-loop.js";
import { decideRetrieval } from "./retrieval-gate.js";
import { MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from "./schema.js";
import { toMatchQuery, toSearchText } from "./search-text.js";
import type {
  ChatLogEntry,
  ConsolidationRun,
  EpisodicMemory,
  MemoryModelOptions,
  MemoryOverview,
  RetrievalResult,
  SemanticMemory,
  SessionSummary,
} from "./types.js";

const DEFAULT_SEMANTIC_LIMIT = 4;
const DEFAULT_EPISODIC_LIMIT = 3;
const MAX_MEMORY_CONTEXT_CHARS = 12_000;

interface Row extends Record<string, unknown> {}

/**
 * 本地记忆的公开入口。
 *
 * 调用方不需要了解 SQLite、FTS5、高水位或 consolidation 事务；所有写操作
 * 都在模块内部保持索引与主表一致。
 */
export class MemoryRuntime {
  readonly databasePath: string;
  private readonly database: DatabaseSync;
  private consolidationQueue: Promise<void> = Promise.resolve();

  constructor(home: string) {
    mkdirSync(home, { recursive: true });
    this.databasePath = join(home, "state.db");
    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(MEMORY_SCHEMA);
    this.assertFts5();
    this.database.prepare(
      "INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)",
    ).run(MEMORY_SCHEMA_VERSION, nowUtc());
  }

  /** 关闭本地数据库连接。 */
  close(): void {
    this.database.close();
  }

  /** 创建一个空 Session。 */
  createSession(title = "新对话"): SessionSummary {
    const id = crypto.randomUUID();
    const timestamp = nowUtc();
    this.database.prepare(
      "INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ).run(id, title.trim() || "新对话", timestamp, timestamp);
    return this.getSession(id)!;
  }

  /** 列出最近活跃的 Session。 */
  listSessions(): SessionSummary[] {
    return (this.database.prepare(`
      SELECT s.*,
             COUNT(c.id) AS message_count,
             COALESCE(SUM(CASE WHEN c.id > s.consolidated_through_message_id AND EXISTS (
               SELECT 1 FROM chat_log done WHERE done.session_id = c.session_id
                 AND done.run_id = c.run_id AND done.kind = 'assistant_message'
             ) THEN 1 ELSE 0 END), 0) AS pending_messages
      FROM sessions s LEFT JOIN chat_log c ON c.session_id = s.id
      GROUP BY s.id ORDER BY s.updated_at DESC, s.created_at DESC
    `).all() as Row[]).map(sessionFromRow);
  }

  /** 修改会话标题。 */
  renameSession(sessionId: string, title: string): SessionSummary {
    const clean = title.trim();
    if (!clean) throw new TypeError("会话标题不能为空");
    const result = this.database.prepare(
      "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
    ).run(clean.slice(0, 120), nowUtc(), sessionId);
    if (Number(result.changes) === 0) throw new Error("Session 不存在");
    return this.getSession(sessionId)!;
  }

  /** 删除完整会话；长期记忆不会随之删除。 */
  deleteSession(sessionId: string): void {
    const result = this.database.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
    if (Number(result.changes) === 0) throw new Error("Session 不存在");
  }

  /** 保存一次运行的用户输入；失败运行仍保留这条记录。 */
  startRun(sessionId: string, runId: string, prompt: string): ChatLogEntry {
    if (!this.getSession(sessionId)) throw new Error("Session 不存在");
    const timestamp = nowUtc();
    const result = this.database.prepare(`
      INSERT INTO chat_log(session_id, run_id, role, kind, content_json, created_at)
      VALUES (?, ?, 'user', 'user_message', ?, ?)
    `).run(sessionId, runId, JSON.stringify(prompt), timestamp);
    const current = this.getSession(sessionId)!;
    const title = current.messageCount === 1 && current.title === "新对话"
      ? prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "新对话"
      : current.title;
    this.database.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, timestamp, sessionId);
    return this.getChatEntry(Number(result.lastInsertRowid));
  }

  /** 保存 Agent Loop 追加的结构化消息。 */
  completeRun(sessionId: string, runId: string, messages: AgentMessage[]): void {
    const insert = this.database.prepare(`
      INSERT INTO chat_log(session_id, run_id, role, kind, content_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      for (const message of messages) {
        const role = message.role === "assistant" ? "assistant" : "user";
        insert.run(
          sessionId,
          runId,
          role,
          messageKind(message),
          JSON.stringify(removeCredentials(message.content)),
          nowUtc(),
        );
      }
      this.database.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowUtc(), sessionId);
    });
  }

  /** 返回 Session 的全部持久化消息，供聊天界面读取。 */
  getChatLog(sessionId?: string, limit = 500): ChatLogEntry[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
    const rows = sessionId
      ? this.database.prepare("SELECT * FROM chat_log WHERE session_id = ? ORDER BY id LIMIT ?").all(sessionId, safeLimit)
      : this.database.prepare("SELECT * FROM chat_log ORDER BY id DESC LIMIT ?").all(safeLimit).reverse();
    return (rows as Row[]).map(chatFromRow);
  }

  /** 返回最近 N 个已完成回合的完整模型消息序列。 */
  getWorkingMemory(sessionId: string, turns: number): AgentMessage[] {
    const runRows = this.database.prepare(`
      SELECT run_id, MIN(id) AS first_id
      FROM chat_log WHERE session_id = ?
      GROUP BY run_id
      HAVING SUM(CASE WHEN kind = 'assistant_message' THEN 1 ELSE 0 END) > 0
      ORDER BY first_id DESC LIMIT ?
    `).all(sessionId, turns) as Row[];
    const runIds = runRows.map((row) => String(row.run_id)).reverse();
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(",");
    const rows = this.database.prepare(
      `SELECT * FROM chat_log WHERE session_id = ? AND run_id IN (${placeholders}) ORDER BY id`,
    ).all(sessionId, ...runIds) as Row[];
    return rows.map((row) => ({ role: String(row.role), content: parseJson(String(row.content_json)) }));
  }

  /** 检索语义与情景记忆，并生成可直接附加到 System Prompt 的文本。 */
  async retrieve(
    message: string,
    gateHistory: AgentMessage[],
    options: MemoryModelOptions,
  ): Promise<RetrievalResult> {
    const observer = options.observer ?? (() => {});
    const decision = await decideRetrieval(options.client, options.model, message, gateHistory, observer);
    if (!decision.retrieve) return { context: "", retrieved: false, semantic: [], episodic: [] };
    const semantic = this.searchSemantic(decision.query, DEFAULT_SEMANTIC_LIMIT);
    const episodic = this.searchEpisodic(decision.query, DEFAULT_EPISODIC_LIMIT);
    await observer("retrieval", {
      query: decision.query.slice(0, 240),
      semantic: semantic.map((item) => ({ id: item.id, score: item.score })),
      episodic: episodic.map((item) => ({ id: item.id, score: item.score })),
    });
    return {
      retrieved: true,
      semantic,
      episodic,
      context: formatMemoryContext(semantic, episodic).slice(0, MAX_MEMORY_CONTEXT_CHARS),
    };
  }

  /** 使用 FTS5 + BM25 搜索 semantic memory。 */
  searchSemantic(query: string, limit = 100): SemanticMemory[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    return (this.database.prepare(`
      SELECT m.*, bm25(semantic_memory_fts, 2.0, 1.0) AS score
      FROM semantic_memory_fts f JOIN semantic_memory m ON m.id = f.rowid
      WHERE semantic_memory_fts MATCH ? ORDER BY score LIMIT ?
    `).all(match, limit) as Row[]).map(semanticFromRow);
  }

  /** 使用 FTS5 + BM25 搜索 episodic memory。 */
  searchEpisodic(query: string, limit = 100): EpisodicMemory[] {
    const match = toMatchQuery(query);
    if (!match) return [];
    return (this.database.prepare(`
      SELECT m.*, bm25(episodic_memory_fts) AS score
      FROM episodic_memory_fts f JOIN episodic_memory m ON m.id = f.rowid
      WHERE episodic_memory_fts MATCH ? ORDER BY score LIMIT ?
    `).all(match, limit) as Row[]).map(episodicFromRow);
  }

  listSemantic(): SemanticMemory[] {
    return (this.database.prepare("SELECT * FROM semantic_memory ORDER BY updated_at DESC, id DESC").all() as Row[])
      .map(semanticFromRow);
  }

  listEpisodic(): EpisodicMemory[] {
    return (this.database.prepare("SELECT * FROM episodic_memory ORDER BY happened_at DESC, id DESC").all() as Row[])
      .map(episodicFromRow);
  }

  createSemantic(subject: string, content: string, source = "user"): SemanticMemory {
    const cleanSubject = requiredMemoryText(subject, "Subject");
    const cleanContent = requiredMemoryText(content, "Content");
    const timestamp = nowUtc();
    const result = this.database.prepare(`
      INSERT INTO semantic_memory(subject, content, source, search_text, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(cleanSubject, cleanContent, source, toSearchText(`${cleanSubject} ${cleanContent}`), timestamp, timestamp);
    const id = Number(result.lastInsertRowid);
    this.audit("semantic", id, "create", source);
    return this.getSemantic(id)!;
  }

  updateSemantic(id: number, subject: string, content: string, source = "ui"): SemanticMemory {
    const cleanSubject = requiredMemoryText(subject, "Subject");
    const cleanContent = requiredMemoryText(content, "Content");
    const result = this.database.prepare(`
      UPDATE semantic_memory SET subject = ?, content = ?, source = ?, search_text = ?, updated_at = ? WHERE id = ?
    `).run(cleanSubject, cleanContent, source, toSearchText(`${cleanSubject} ${cleanContent}`), nowUtc(), id);
    if (Number(result.changes) === 0) throw new Error("Semantic memory 不存在");
    this.audit("semantic", id, "update", source);
    return this.getSemantic(id)!;
  }

  deleteSemantic(id: number, source = "ui"): void {
    const result = this.database.prepare("DELETE FROM semantic_memory WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new Error("Semantic memory 不存在");
    this.audit("semantic", id, "delete", source);
  }

  createEpisodic(summary: string, happenedAt: string, source = "ui"): EpisodicMemory {
    const cleanSummary = requiredMemoryText(summary, "Summary");
    const timestamp = nowUtc();
    const result = this.database.prepare(`
      INSERT INTO episodic_memory(session_id, summary, happened_at, source, search_text, created_at, updated_at)
      VALUES (NULL, ?, ?, ?, ?, ?, ?)
    `).run(cleanSummary, happenedAt, source, toSearchText(cleanSummary), timestamp, timestamp);
    const id = Number(result.lastInsertRowid);
    this.audit("episodic", id, "create", source);
    return this.getEpisodic(id)!;
  }

  updateEpisodic(id: number, summary: string, happenedAt: string, source = "ui"): EpisodicMemory {
    const cleanSummary = requiredMemoryText(summary, "Summary");
    const result = this.database.prepare(`
      UPDATE episodic_memory SET summary = ?, happened_at = ?, source = ?, search_text = ?, updated_at = ? WHERE id = ?
    `).run(cleanSummary, happenedAt, source, toSearchText(cleanSummary), nowUtc(), id);
    if (Number(result.changes) === 0) throw new Error("Episodic memory 不存在");
    this.audit("episodic", id, "update", source);
    return this.getEpisodic(id)!;
  }

  deleteEpisodic(id: number, source = "ui"): void {
    const result = this.database.prepare("DELETE FROM episodic_memory WHERE id = ?").run(id);
    if (Number(result.changes) === 0) throw new Error("Episodic memory 不存在");
    this.audit("episodic", id, "delete", source);
  }

  /** 将一个 Session 的增量整理任务加入单一后台队列。 */
  scheduleConsolidation(sessionId: string, trigger: "new_session" | "startup", options: MemoryModelOptions): void {
    this.consolidationQueue = this.consolidationQueue
      .then(() => this.consolidateSession(sessionId, trigger, options))
      .catch(() => undefined);
  }

  /** 启动时恢复所有存在增量积压的 Session。 */
  schedulePendingConsolidations(options: MemoryModelOptions): void {
    for (const session of this.listSessions().filter((item) => item.pendingMessages > 0)) {
      this.scheduleConsolidation(session.id, "startup", options);
    }
  }

  /** 等待后台整理完成，主要用于关闭流程与行为测试。 */
  async waitForConsolidation(): Promise<void> {
    await this.consolidationQueue;
  }

  listConsolidations(limit = 100): ConsolidationRun[] {
    return (this.database.prepare("SELECT * FROM consolidation_runs ORDER BY id DESC LIMIT ?").all(limit) as Row[])
      .map(consolidationFromRow);
  }

  overview(): MemoryOverview {
    const count = (table: string) => Number((this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as Row).count);
    const pendingSessionCount = this.listSessions().filter((session) => session.pendingMessages > 0).length;
    return {
      semanticCount: count("semantic_memory"),
      episodicCount: count("episodic_memory"),
      sessionCount: count("sessions"),
      pendingSessionCount,
      databasePath: this.databasePath,
      latestConsolidation: this.listConsolidations(1)[0] ?? null,
    };
  }

  private async consolidateSession(
    sessionId: string,
    trigger: string,
    options: MemoryModelOptions,
  ): Promise<void> {
    const session = this.getSessionRow(sessionId);
    if (!session) return;
    const watermark = Number(session.consolidated_through_message_id);
    const rows = this.database.prepare(`
      SELECT c.* FROM chat_log c
      WHERE c.session_id = ? AND c.id > ?
        AND EXISTS (
          SELECT 1 FROM chat_log done
          WHERE done.session_id = c.session_id AND done.run_id = c.run_id AND done.kind = 'assistant_message'
        )
      ORDER BY c.id
    `).all(sessionId, watermark) as Row[];
    if (rows.length === 0) return;
    const throughMessageId = Math.max(...rows.map((row) => Number(row.id)));
    const relevant = rows.filter((row) => row.kind === "user_message" || row.kind === "assistant_message");
    if (relevant.length === 0) return;

    const runId = crypto.randomUUID();
    const startedAt = nowUtc();
    const insert = this.database.prepare(`
      INSERT INTO consolidation_runs(run_id, session_id, trigger, status, through_message_id, started_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(runId, sessionId, trigger, throughMessageId, startedAt);
    const consolidationId = Number(insert.lastInsertRowid);
    const observer = options.observer ?? (() => {});
    await observer("consolidation_start", { runId, sessionId, trigger, throughMessageId });

    try {
      const episode = this.database.prepare("SELECT * FROM episodic_memory WHERE session_id = ?").get(sessionId) as Row | undefined;
      const transcript = relevant.map((row) => `${row.role}: ${plainText(parseJson(String(row.content_json)))}`).join("\n");
      const candidates = this.searchSemantic(transcript.slice(0, 5_000), 12);
      const response = await options.client.messages.create({
        model: options.model,
        system: consolidationSystemPrompt(),
        messages: [{
          role: "user",
          content: `Existing Episode: ${episode ? String(episode.summary) : "（无）"}\n\nRelated Facts:\n${candidates.map((item) => `#${item.id} ${item.subject}: ${item.content}`).join("\n") || "（无）"}\n\nNew Dialogue:\n${transcript}`,
        }],
        tools: [],
        max_tokens: 4096,
        signal: undefined,
      });
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("");
      const distilled = parseConsolidation(text);
      let factsCreated = 0;
      let factsUpdated = 0;
      let factsSkipped = 0;
      let episodeChanged = false;

      this.transaction(() => {
        for (const fact of distilled.facts) {
          if (fact.action === "create" && fact.subject && fact.content) {
            this.createSemantic(fact.subject, fact.content, "consolidation");
            factsCreated += 1;
          } else if (fact.action === "update" && fact.id && fact.subject && fact.content && this.getSemantic(fact.id)) {
            this.updateSemantic(fact.id, fact.subject, fact.content, "consolidation");
            factsUpdated += 1;
          } else {
            factsSkipped += 1;
          }
        }
        if (distilled.episode) {
          const happenedAt = String(relevant.at(-1)!.created_at);
          if (episode) {
            this.updateEpisodic(Number(episode.id), distilled.episode, happenedAt, "consolidation");
          } else {
            const timestamp = nowUtc();
            const result = this.database.prepare(`
              INSERT INTO episodic_memory(session_id, summary, happened_at, source, search_text, created_at, updated_at)
              VALUES (?, ?, ?, 'consolidation', ?, ?, ?)
            `).run(sessionId, distilled.episode, happenedAt, toSearchText(distilled.episode), timestamp, timestamp);
            this.audit("episodic", Number(result.lastInsertRowid), "create", "consolidation");
          }
          episodeChanged = true;
        }
        this.database.prepare("UPDATE sessions SET consolidated_through_message_id = ? WHERE id = ?")
          .run(throughMessageId, sessionId);
        this.database.prepare(`
          UPDATE consolidation_runs SET status = 'completed', facts_created = ?, facts_updated = ?,
            facts_skipped = ?, episode_changed = ?, completed_at = ? WHERE id = ?
        `).run(factsCreated, factsUpdated, factsSkipped, episodeChanged ? 1 : 0, nowUtc(), consolidationId);
      });
      await observer("consolidation_end", {
        runId, sessionId, throughMessageId, factsCreated, factsUpdated, factsSkipped, episodeChanged,
      });
    } catch (error) {
      const errorType = error instanceof Error ? error.name : "UnknownError";
      this.database.prepare(`
        UPDATE consolidation_runs SET status = 'failed', error_type = ?, completed_at = ? WHERE id = ?
      `).run(errorType, nowUtc(), consolidationId);
      await observer("consolidation_error", { runId, sessionId, throughMessageId, errorType });
      throw error;
    }
  }

  private getSession(id: string): SessionSummary | null {
    const row = this.database.prepare(`
      SELECT s.*, COUNT(c.id) AS message_count,
             COALESCE(SUM(CASE WHEN c.id > s.consolidated_through_message_id AND EXISTS (
               SELECT 1 FROM chat_log done WHERE done.session_id = c.session_id
                 AND done.run_id = c.run_id AND done.kind = 'assistant_message'
             ) THEN 1 ELSE 0 END), 0) AS pending_messages
      FROM sessions s LEFT JOIN chat_log c ON c.session_id = s.id WHERE s.id = ? GROUP BY s.id
    `).get(id) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  private getSessionRow(id: string): Row | undefined {
    return this.database.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
  }

  private getChatEntry(id: number): ChatLogEntry {
    return chatFromRow(this.database.prepare("SELECT * FROM chat_log WHERE id = ?").get(id) as Row);
  }

  private getSemantic(id: number): SemanticMemory | null {
    const row = this.database.prepare("SELECT * FROM semantic_memory WHERE id = ?").get(id) as Row | undefined;
    return row ? semanticFromRow(row) : null;
  }

  private getEpisodic(id: number): EpisodicMemory | null {
    const row = this.database.prepare("SELECT * FROM episodic_memory WHERE id = ?").get(id) as Row | undefined;
    return row ? episodicFromRow(row) : null;
  }

  private audit(memoryType: string, memoryId: number, action: string, source: string): void {
    this.database.prepare(`
      INSERT INTO memory_audit(memory_type, memory_id, action, source, created_at) VALUES (?, ?, ?, ?, ?)
    `).run(memoryType, memoryId, action, source, nowUtc());
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private assertFts5(): void {
    try {
      this.database.prepare("SELECT COUNT(*) AS count FROM semantic_memory_fts").get();
    } catch (error) {
      throw new Error("当前 Node.js 内置 SQLite 未启用 FTS5", { cause: error });
    }
  }
}

function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function requiredMemoryText(value: string, field: string): string {
  const clean = value.trim();
  if (!clean) throw new TypeError(`${field} 不能为空`);
  return clean;
}

function messageKind(message: AgentMessage): string {
  if (message.role === "assistant" && Array.isArray(message.content)
    && message.content.some((block: unknown) => isBlock(block, "tool_use"))) return "assistant_tool_call";
  if (message.role === "user" && Array.isArray(message.content)
    && message.content.some((block: unknown) => isBlock(block, "tool_result"))) return "tool_result";
  return message.role === "assistant" ? "assistant_message" : "user_message";
}

function isBlock(value: unknown, type: string): boolean {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === type);
}

function removeCredentials(value: unknown, key = ""): unknown {
  if (/api[-_]?key|authorization|cookie|token|secret|password/i.test(key)) return "[凭证已移除]";
  if (Array.isArray(value)) return value.map((item) => removeCredentials(item));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, removeCredentials(entryValue, entryKey)]));
}

function plainText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");
  return content.filter((block) => isBlock(block, "text"))
    .map((block) => String((block as { text?: unknown }).text ?? "")).join("");
}

function localTimestamp(value: string): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}

function formatMemoryContext(semantic: SemanticMemory[], episodic: EpisodicMemory[]): string {
  const sections: string[] = [];
  if (semantic.length) {
    sections.push("Relevant semantic memory:", ...semantic.map((item) =>
      `- [Semantic #${item.id} · 创建 ${localTimestamp(item.createdAt)} · 更新 ${localTimestamp(item.updatedAt)}] ${item.subject}: ${item.content}`));
  }
  if (episodic.length) {
    sections.push("Relevant episodic memory:", ...episodic.map((item) =>
      `- [Episodic #${item.id} · 发生 ${localTimestamp(item.happenedAt)}] ${item.summary}`));
  }
  return sections.join("\n");
}

function consolidationSystemPrompt(): string {
  return `你负责把一个个人助理 Session 的新增对话整理为长期记忆。记忆必须保持原对话语言，不得强制翻译。
事实允许来自 user 或 assistant。对照已有事实，只输出 create、update 或 noop；update 必须引用已有整数 ID，不得删除。
episode 代表整个 Session 发生的重要事件、决定、承诺或任务结果。闲聊和普通问答可返回 null。已有 episode 存在时，用新增对话更新为覆盖完整 Session 的单句总结。
只输出 JSON：{"facts":[{"action":"create|update|noop","id":1,"subject":"主题","content":"事实"}],"episode":"单句总结或 null"}`;
}

function parseConsolidation(text: string): {
  facts: Array<{ action: string; id?: number; subject?: string; content?: string }>;
  episode: string | null;
} {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new TypeError("Consolidation 未返回 JSON");
  const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  const facts = Array.isArray(value.facts) ? value.facts.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")) : [];
  return {
    facts: facts.map((item) => ({
      action: String(item.action ?? "noop"),
      ...(typeof item.id === "number" ? { id: item.id } : {}),
      ...(typeof item.subject === "string" ? { subject: item.subject } : {}),
      ...(typeof item.content === "string" ? { content: item.content } : {}),
    })),
    episode: typeof value.episode === "string" && value.episode.trim() ? value.episode.trim() : null,
  };
}

function sessionFromRow(row: Row): SessionSummary {
  return {
    id: String(row.id),
    title: String(row.title),
    messageCount: Number(row.message_count ?? 0),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    pendingMessages: Number(row.pending_messages ?? 0),
  };
}

function chatFromRow(row: Row): ChatLogEntry {
  return {
    id: Number(row.id), sessionId: String(row.session_id), runId: String(row.run_id),
    role: String(row.role), kind: String(row.kind), content: parseJson(String(row.content_json)), createdAt: String(row.created_at),
  };
}

function semanticFromRow(row: Row): SemanticMemory {
  return {
    id: Number(row.id), subject: String(row.subject), content: String(row.content), source: String(row.source),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.score === undefined ? {} : { score: Number(row.score) }),
  };
}

function episodicFromRow(row: Row): EpisodicMemory {
  return {
    id: Number(row.id), sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    summary: String(row.summary), happenedAt: String(row.happened_at), source: String(row.source),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    ...(row.score === undefined ? {} : { score: Number(row.score) }),
  };
}

function consolidationFromRow(row: Row): ConsolidationRun {
  return {
    id: Number(row.id), runId: String(row.run_id), sessionId: String(row.session_id), trigger: String(row.trigger),
    status: String(row.status), throughMessageId: Number(row.through_message_id), factsCreated: Number(row.facts_created),
    factsUpdated: Number(row.facts_updated), factsSkipped: Number(row.facts_skipped), episodeChanged: Boolean(row.episode_changed),
    errorType: row.error_type === null || row.error_type === undefined ? null : String(row.error_type),
    startedAt: String(row.started_at), completedAt: row.completed_at === null || row.completed_at === undefined ? null : String(row.completed_at),
  };
}
