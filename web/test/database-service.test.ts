import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { executeDatabaseSql, loadDatabaseDashboard } from "../server/database-service.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Database 页面服务", () => {
  it("列出所有普通表并排除 SQLite 与 FTS5 索引中间表", async () => {
    const databasePath = await createDatabase();
    const database = new DatabaseSync(databasePath);
    database.exec(`
      CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL);
      CREATE TABLE memory_tasks (id TEXT PRIMARY KEY, status TEXT);
      CREATE VIRTUAL TABLE sessions_fts USING fts5(title, content='sessions', content_rowid='id');
      INSERT INTO sessions(title) VALUES ('第二条'), ('第三条');
    `);
    database.close();

    const dashboard = loadDatabaseDashboard(databasePath);

    expect(dashboard.tables.map((table) => table.name)).toEqual(["memory_tasks", "sessions"]);
    expect(dashboard.tables.find((table) => table.name === "sessions")).toMatchObject({
      count: 2,
      columns: [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "title", type: "TEXT", notNull: true },
      ],
      rows: [[2, "第三条"], [1, "第二条"]],
    });
  });

  it("查询最多返回 200 行并允许字符串中的分号", async () => {
    const databasePath = await createDatabase();
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, content TEXT)");
    const insert = database.prepare("INSERT INTO items(id, content) VALUES (?, ?)");
    for (let id = 1; id <= 205; id += 1) insert.run(id, `内容 ${id}`);
    database.close();

    const result = executeDatabaseSql(databasePath, "SELECT id, ';' AS separator FROM items ORDER BY id;");

    expect(result.kind).toBe("read");
    expect(result.columns).toEqual(["id", "separator"]);
    expect(result.rows).toHaveLength(200);
    expect(result.truncated).toBe(true);
  });

  it("数据写入要求确认并返回受影响行数", async () => {
    const databasePath = await createDatabase();
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, content TEXT)");
    database.close();

    expect(() => executeDatabaseSql(databasePath, "INSERT INTO items(content) VALUES ('已确认')"))
      .toThrow("写操作需要二次确认");

    const result = executeDatabaseSql(
      databasePath,
      "INSERT INTO items(content) VALUES ('已确认')",
      "CONFIRM_DATABASE_WRITE",
    );
    expect(result).toMatchObject({ kind: "write", changes: 1, lastInsertRowid: 1 });
    expect(executeDatabaseSql(databasePath, "SELECT content FROM items").rows).toEqual([["已确认"]]);
  });

  it("拒绝结构变更、PRAGMA、多语句以及可写 WITH", async () => {
    const databasePath = await createDatabase();
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, content TEXT)");
    database.close();

    expect(() => executeDatabaseSql(databasePath, "DROP TABLE items", "CONFIRM_DATABASE_WRITE")).toThrow("不允许修改数据库结构");
    expect(() => executeDatabaseSql(databasePath, "PRAGMA table_info(items)")).toThrow("不允许修改数据库结构");
    expect(() => executeDatabaseSql(databasePath, "SELECT * FROM items; DELETE FROM items", "CONFIRM_DATABASE_WRITE")).toThrow("每次只能执行一条 SQL");
    expect(() => executeDatabaseSql(databasePath, "WITH changed AS (DELETE FROM items RETURNING id) SELECT * FROM changed"))
      .toThrow("WITH 仅允许只读 SELECT 查询");
  });
});

async function createDatabase(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "everything-database-test-"));
  directories.push(directory);
  return join(directory, "state.db");
}
