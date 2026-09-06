import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MEMORY_SCHEMA, MEMORY_SCHEMA_VERSION } from "./schema.ts";
import { nowUtc } from "./records.ts";

/** 数据库连接、Schema 初始化与同步事务。 */
export class MemoryDatabase {
  readonly databasePath: string;
  readonly connection: DatabaseSync;

  constructor(home: string) {
    const databaseDirectory = join(home, "database");
    mkdirSync(databaseDirectory, { recursive: true });
    this.databasePath = join(databaseDirectory, "state.db");
    let connection = new DatabaseSync(this.databasePath);
    const hasMigrations = connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    const version = hasMigrations
      ? Number(connection.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get()!.version) : 0;
    // 开发阶段不迁移旧库：版本不匹配时直接删除数据库及其 sidecar，再创建当前 Schema。
    if (version !== MEMORY_SCHEMA_VERSION) {
      connection.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${this.databasePath}${suffix}`, { force: true });
      connection = new DatabaseSync(this.databasePath);
    }
    this.connection = connection;
    this.initializeSchema();
    this.assertFts5();
  }

  private initializeSchema(): void {
    this.connection.exec(MEMORY_SCHEMA);
    this.connection.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(MEMORY_SCHEMA_VERSION, nowUtc());
    this.connection.prepare("UPDATE memory_tasks SET status='pending', attempts=MAX(0, attempts-1) WHERE status='running'").run();
    // 进程重启后不可能继续持有旧 HTTP 状态，未完成的影子任务明确标为 interrupted。
    this.connection.prepare(`
      UPDATE embedding_rebuilds SET status='interrupted', completed_at=? WHERE status='running'
    `).run(nowUtc());
    this.connection.prepare("UPDATE embedding_generations SET status='interrupted' WHERE status='building'").run();
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
