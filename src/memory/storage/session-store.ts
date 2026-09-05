import type { AgentMessage } from "../../agent-loop/agent-loop.ts";
import { toSearchText } from "../retrieve/index.ts";
import type { ChatLogEntry, SessionSummary } from "../types.ts";
import type { Row } from "./records.ts";
import { nowUtc, parseJson, messageKind, removeCredentials, plainText, sessionFromRow, chatFromRow } from "./records.ts";
import type { MemoryDatabase } from "./database.ts";

/** Session 与 Chat Log 存储，保证完整回合和检索投影同步写入。 */
export class SessionStore {
  private readonly storage: MemoryDatabase;

  constructor(storage: MemoryDatabase) {
    this.storage = storage;
  }

  /** 创建一个空 Session。 */
  createSession(title = "新对话"): SessionSummary {
    const id = crypto.randomUUID(); const timestamp = nowUtc();
    this.storage.connection.prepare("INSERT INTO sessions(id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, title.trim() || "新对话", timestamp, timestamp);
    return this.requireSession(id);
  }

  /** 返回最近的已有 Session；仅在数据库为空时创建默认 Session。 */
  ensureSession(): SessionSummary { return this.listSessions()[0] ?? this.createSession() }

  /** 列出最近活跃的 Session，并显式统计完整与未完成 run。 */
  listSessions(): SessionSummary[] {
    return (this.storage.connection.prepare(sessionSummarySql("")).all() as Row[]).map(sessionFromRow);
  }

  renameSession(sessionId: string, title: string): SessionSummary {
    const clean = title.trim(); if (!clean) throw new TypeError("会话标题不能为空");
    const result = this.storage.connection.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(clean.slice(0, 120), nowUtc(), sessionId);
    if (Number(result.changes) === 0) throw new Error("Session 不存在");
    return this.requireSession(sessionId);
  }

  /** 删除完整 Session；Chat Log 与 FTS 投影同步级联删除。 */
  deleteSession(sessionId: string): void {
    this.storage.transaction(() => {
      const result = this.storage.connection.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
      if (Number(result.changes) === 0) throw new Error("Session 不存在");
    });
  }

  /** 保存一次运行的用户输入；失败运行只保留在 Chat Log，不进入检索。 */
  startRun(sessionId: string, runId: string, prompt: string): ChatLogEntry {
    if (!this.getSession(sessionId)) throw new Error("Session 不存在");
    const timestamp = nowUtc();
    const result = this.storage.connection.prepare(`
      INSERT INTO chat_log(session_id, run_id, role, kind, content_json, search_text, created_at)
      VALUES (?, ?, 'user', 'user_message', ?, ?, ?)
    `).run(sessionId, runId, JSON.stringify(prompt), "", timestamp);
    const current = this.requireSession(sessionId);
    const title = current.messageCount === 1 && current.title === "新对话"
      ? prompt.trim().replace(/\s+/g, " ").slice(0, 60) || "新对话" : current.title;
    this.storage.connection.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, timestamp, sessionId);
    return this.getChatEntry(Number(result.lastInsertRowid));
  }

  /** 保存成功 run；原文与 FTS 在本地事务中原子提交，不依赖远程服务。 */
  async completeRun(sessionId: string, runId: string, messages: AgentMessage[]): Promise<void> {
    const promptRow = this.storage.connection.prepare(`
      SELECT id, content_json FROM chat_log
      WHERE session_id = ? AND run_id = ? AND kind = 'user_message'
      ORDER BY id LIMIT 1
    `).get(sessionId, runId) as Row | undefined;
    if (!promptRow) throw new Error("Run 的用户消息不存在");
    const finalMessage = [...messages].reverse().find((message) => messageKind(message) === "assistant_message");
    if (!finalMessage) throw new Error("成功 Run 必须包含最终 Assistant 回复");
    const prompt = plainText(parseJson(String(promptRow.content_json)));
    const insert = this.storage.connection.prepare(`
      INSERT INTO chat_log(session_id, run_id, role, kind, content_json, search_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    this.storage.transaction(() => {
      this.storage.connection.prepare("UPDATE chat_log SET search_text = ? WHERE id = ?")
        .run(toSearchText(prompt), Number(promptRow.id));
      for (const message of messages) {
        const role = message.role === "assistant" ? "assistant" : "user";
        const kind = messageKind(message);
        const content = removeCredentials(message.content);
        const searchText = kind === "user_message" || kind === "assistant_message" ? toSearchText(plainText(content)) : "";
        insert.run(sessionId, runId, role, kind, JSON.stringify(content), searchText, nowUtc());
      }
      this.storage.connection.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(nowUtc(), sessionId);
    });
  }

  /** 返回 Session 的全部持久化消息，供聊天界面读取。 */
  getChatLog(sessionId?: string, limit = 2_000): ChatLogEntry[] {
    const safeLimit = Math.max(1, Math.min(2_000, Math.trunc(limit)));
    const rows = sessionId
      ? this.storage.connection.prepare("SELECT * FROM chat_log WHERE session_id = ? ORDER BY id LIMIT ?").all(sessionId, safeLimit)
      : this.storage.connection.prepare("SELECT * FROM chat_log ORDER BY id DESC LIMIT ?").all(safeLimit).reverse();
    return this.decorateEntries(rows as Row[]);
  }

  /** 返回全部已完成回合；turns 仅供 Gate 读取少量近期上下文。 */
  getWorkingMemory(sessionId: string, turns?: number): AgentMessage[] {
    let runRows: Row[];
    if (turns === undefined) {
      runRows = this.storage.connection.prepare(`
        SELECT run_id, MIN(id) AS first_id FROM chat_log WHERE session_id = ?
        GROUP BY run_id HAVING SUM(CASE WHEN kind = 'assistant_message' THEN 1 ELSE 0 END) > 0 ORDER BY first_id
      `).all(sessionId) as Row[];
    } else {
      runRows = (this.storage.connection.prepare(`
        SELECT run_id, MIN(id) AS first_id FROM chat_log WHERE session_id = ?
        GROUP BY run_id HAVING SUM(CASE WHEN kind = 'assistant_message' THEN 1 ELSE 0 END) > 0
        ORDER BY first_id DESC LIMIT ?
      `).all(sessionId, turns) as Row[]).reverse();
    }
    const runIds = runRows.map((row) => String(row.run_id));
    if (!runIds.length) return [];
    const placeholders = runIds.map(() => "?").join(",");
    return (this.storage.connection.prepare(`SELECT * FROM chat_log WHERE session_id = ? AND run_id IN (${placeholders}) ORDER BY id`)
      .all(sessionId, ...runIds) as Row[])
      .map((row) => ({ role: String(row.role), content: parseJson(String(row.content_json)) }));
  }

  private getSession(id: string): SessionSummary | null {
    const row = this.storage.connection.prepare(sessionSummarySql("WHERE s.id = ?")).get(id) as Row | undefined;
    return row ? sessionFromRow(row) : null;
  }

  requireSession(id: string): SessionSummary {
    const session = this.getSession(id); if (!session) throw new Error("SESSION_NOT_FOUND"); return session;
  }

  getSessionRow(id: string): Row | undefined { return this.storage.connection.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined }

  completedRunRows(sessionId: string): Row[] {
    return this.storage.connection.prepare(`
      SELECT c.* FROM chat_log c
      WHERE c.session_id = ? AND EXISTS (
        SELECT 1 FROM chat_log done
        WHERE done.session_id = c.session_id AND done.run_id = c.run_id
          AND done.kind = 'assistant_message'
      )
      ORDER BY c.id
    `).all(sessionId) as Row[];
  }

  private getChatEntry(id: number): ChatLogEntry { return chatFromRow(this.storage.connection.prepare("SELECT * FROM chat_log WHERE id = ?").get(id) as Row) }

  decorateEntries(rows: Row[]): ChatLogEntry[] { return this.decorateEntriesFromEntries(rows.map(chatFromRow), rows) }

  decorateEntriesFromEntries(entries: ChatLogEntry[], allRows: Row[]): ChatLogEntry[] {
    const completed = new Set(allRows.filter((row) => row.kind === "assistant_message").map((row) => String(row.run_id)));
    return entries.map((entry) => ({ ...entry, runComplete: completed.has(entry.runId) }));
  }
}

function sessionSummarySql(where: string): string {
  return `
    SELECT s.*, COUNT(c.id) AS message_count,
      COUNT(DISTINCT CASE WHEN EXISTS (
        SELECT 1 FROM chat_log done WHERE done.session_id=c.session_id AND done.run_id=c.run_id AND done.kind='assistant_message'
      ) THEN c.run_id END) AS completed_run_count,
      COUNT(DISTINCT CASE WHEN NOT EXISTS (
        SELECT 1 FROM chat_log done WHERE done.session_id=c.session_id AND done.run_id=c.run_id AND done.kind='assistant_message'
      ) THEN c.run_id END) AS incomplete_run_count,
      COALESCE(SUM(CASE WHEN c.id > s.consolidated_through_message_id AND EXISTS (
        SELECT 1 FROM chat_log done WHERE done.session_id=c.session_id AND done.run_id=c.run_id AND done.kind='assistant_message'
      ) THEN 1 ELSE 0 END), 0) AS pending_messages
    FROM sessions s LEFT JOIN chat_log c ON c.session_id=s.id ${where}
    GROUP BY s.id ORDER BY s.updated_at DESC, s.id ASC
  `;
}
