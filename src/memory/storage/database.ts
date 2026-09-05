import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from "./schema.ts";
import type { Row } from "./records.ts";
import { nowUtc } from "./records.ts";

/** 数据库连接、Schema 初始化与同步事务。 */
export class MemoryDatabase {
  readonly databasePath: string;
  readonly connection: DatabaseSync;

  constructor(home: string) {
    const databaseDirectory = join(home, "database");
    mkdirSync(databaseDirectory, { recursive: true });
    this.databasePath = join(databaseDirectory, "state.db");
    this.connection = new DatabaseSync(this.databasePath);
    this.initializeSchema();
    this.assertFts5();
  }

  private initializeSchema(): void {
    this.connection.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    const hasMigrations = Boolean((this.connection.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get() as Row | undefined)?.ok);
    const version = hasMigrations
      ? Number((this.connection.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as Row).version) : 0;
    if (version < 2) {
      this.connection.exec(`
        PRAGMA foreign_keys = OFF;
        DROP TRIGGER IF EXISTS chat_log_ai; DROP TRIGGER IF EXISTS chat_log_ad; DROP TRIGGER IF EXISTS chat_log_au;
        DROP TABLE IF EXISTS chat_log_fts;
        DROP TABLE IF EXISTS episodic_memory_fts; DROP TABLE IF EXISTS episodic_memory;
        DROP TABLE IF EXISTS consolidation_runs;
        DROP TABLE IF EXISTS chat_log; DROP TABLE IF EXISTS sessions;
        PRAGMA foreign_keys = ON;
      `);
      this.connection.exec(MEMORY_SCHEMA);
    } else {
      this.connection.exec(MEMORY_SCHEMA);
    }
    if (version === 3) {
      // Tokenizer 生成的向量索引与估算切块不兼容；只删除可重建派生数据。
      this.connection.exec(`
        DROP TABLE IF EXISTS embedding_rebuilds;
        DROP TABLE IF EXISTS embedding_chunks;
        DROP TABLE IF EXISTS embedding_generations;
      `);
      this.connection.exec(MEMORY_SCHEMA);
    }
    // 进程重启后不可能继续持有旧 HTTP 状态，未完成的影子任务明确标为 interrupted。
    this.connection.prepare(`
      UPDATE embedding_rebuilds SET status='interrupted', completed_at=? WHERE status='running'
    `).run(nowUtc());
    this.connection.prepare("UPDATE embedding_generations SET status='interrupted' WHERE status='building'").run();
    if (version < 3) {
      // 失败 run 只保留 Chat Log；清空其历史检索投影会通过现有 trigger 同步更新 FTS5。
      this.connection.prepare(`
        UPDATE chat_log SET search_text = ''
        WHERE kind = 'user_message'
          AND NOT EXISTS (
            SELECT 1 FROM chat_log done
            WHERE done.session_id = chat_log.session_id
              AND done.run_id = chat_log.run_id
              AND done.kind = 'assistant_message'
          )
      `).run();
    }
    if (version < MEMORY_SCHEMA_VERSION) {
      this.connection.prepare("DELETE FROM schema_migrations").run();
      this.connection.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(MEMORY_SCHEMA_VERSION, nowUtc());
    }
  }

  /** 同步提交一次原子写入；操作失败时回滚并重抛原始错误，不接受异步操作。 */
  transaction<T>(operation: () => T): T {
    this.connection.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.connection.exec("COMMIT"); return result }
    catch (error) { this.connection.exec("ROLLBACK"); throw error }
  }

  private assertFts5(): void {
    try { this.connection.prepare("SELECT COUNT(*) AS count FROM semantic_memory_fts").get(); this.connection.prepare("SELECT COUNT(*) AS count FROM chat_log_fts").get() }
    catch (error) { throw new Error("当前 Node.js 内置 SQLite 未启用 FTS5", { cause: error }) }
  }
}
