import { statSync } from "node:fs";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";

const MAX_ROWS = 200;
const WRITE_CONFIRMATION = "CONFIRM_DATABASE_WRITE";
const WRITE_KEYWORDS = new Set(["insert", "update", "delete"]);
const FORBIDDEN_KEYWORDS = new Set([
  "alter", "attach", "create", "detach", "drop", "pragma", "reindex", "replace", "vacuum",
]);

export interface DatabaseColumn {
  name: string;
  type: string;
  notNull: boolean;
  primaryKey: boolean;
  defaultValue: unknown;
}

export interface DatabaseTable {
  name: string;
  count: number;
  columns: DatabaseColumn[];
  rows: unknown[][];
}

export interface DatabaseDashboard {
  path: string;
  size: number;
  tables: DatabaseTable[];
}

export interface DatabaseQueryResult {
  kind: "read" | "write";
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
  changes: number;
  lastInsertRowid: number | string | null;
}

/** 读取 SQLite 普通表及样本数据，排除 SQLite 和 FTS5 维护的索引中间表。 */
export function loadDatabaseDashboard(databasePath: string): DatabaseDashboard {
  const database = openDatabase(databasePath);
  try {
    const virtualFtsTables = (database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND lower(sql) LIKE 'create virtual table%using fts5%'
    `).all() as Array<{ name: string }>).map((row) => row.name);
    const names = (database.prepare(`
      SELECT name FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map((row) => row.name)
      .filter((name) => !virtualFtsTables.some((root) => name === root || name.startsWith(`${root}_`)));

    return {
      path: databasePath,
      size: statSync(databasePath).size,
      tables: names.map((name) => readTable(database, name)),
    };
  } finally {
    database.close();
  }
}

/** 执行一条查询或数据增删改语句；写操作必须携带页面二次确认令牌。 */
export function executeDatabaseSql(
  databasePath: string,
  sqlInput: unknown,
  confirmation?: unknown,
): DatabaseQueryResult {
  const sql = normalizeSql(sqlInput);
  const classification = classifySql(sql);
  if (classification === "write" && confirmation !== WRITE_CONFIRMATION) {
    throw new TypeError("写操作需要二次确认");
  }

  const database = openDatabase(databasePath);
  try {
    if (classification === "read") return runRead(database, sql);
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = database.prepare(sql).run();
      database.exec("COMMIT");
      return {
        kind: "write",
        columns: [],
        rows: [],
        truncated: false,
        changes: Number(result.changes),
        lastInsertRowid: result.lastInsertRowid === 0
          ? null
          : typeof result.lastInsertRowid === "bigint" ? result.lastInsertRowid.toString() : result.lastInsertRowid,
      };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function readTable(database: DatabaseSync, name: string): DatabaseTable {
  const quotedName = quoteIdentifier(name);
  const columns = (database.prepare(`PRAGMA table_info(${quotedName})`).all() as Array<{
    name: string; type: string; notnull: number; pk: number; dflt_value: SQLOutputValue;
  }>).map((column) => ({
    name: column.name,
    type: column.type,
    notNull: column.notnull === 1,
    primaryKey: column.pk > 0,
    defaultValue: jsonValue(column.dflt_value),
  }));
  const count = Number((database.prepare(`SELECT COUNT(*) AS count FROM ${quotedName}`).get() as { count: number | bigint }).count);
  let rows: unknown[][];
  try {
    rows = readRows(database, `SELECT * FROM ${quotedName} ORDER BY rowid DESC LIMIT ${MAX_ROWS}`).rows;
  } catch {
    rows = readRows(database, `SELECT * FROM ${quotedName} LIMIT ${MAX_ROWS}`).rows;
  }
  return { name, count, columns, rows };
}

function runRead(database: DatabaseSync, sql: string): DatabaseQueryResult {
  const result = readRows(database, sql);
  return { kind: "read", ...result, changes: 0, lastInsertRowid: null };
}

function readRows(database: DatabaseSync, sql: string): Pick<DatabaseQueryResult, "columns" | "rows" | "truncated"> {
  const statement = database.prepare(sql);
  statement.setReturnArrays(true);
  const columns = statement.columns().map((column) => column.name);
  const rows: unknown[][] = [];
  for (const row of statement.iterate() as NodeJS.Iterator<SQLOutputValue[]>) {
    if (rows.length === MAX_ROWS) return { columns, rows, truncated: true };
    rows.push(row.map(jsonValue));
  }
  return { columns, rows, truncated: false };
}

function openDatabase(databasePath: string): DatabaseSync {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  return database;
}

function normalizeSql(value: unknown): string {
  if (typeof value !== "string" || value.length > 100_000) throw new TypeError("SQL 必须是小于 100KB 的字符串");
  let sql = value.trim();
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trimEnd();
  if (!sql) throw new TypeError("请输入 SQL");
  return sql;
}

function classifySql(sql: string): "read" | "write" {
  const tokens = sqlTokens(sql);
  if (tokens.semicolon) throw new TypeError("每次只能执行一条 SQL，语句中不能包含分号");
  const first = tokens.words[0];
  if (first === "select") return "read";
  if (first === "with") {
    if (tokens.words.some((word) => WRITE_KEYWORDS.has(word) || FORBIDDEN_KEYWORDS.has(word))) {
      throw new TypeError("WITH 仅允许只读 SELECT 查询");
    }
    if (!tokens.words.includes("select")) throw new TypeError("WITH 必须包含 SELECT 查询");
    return "read";
  }
  if (first && WRITE_KEYWORDS.has(first)) return "write";
  throw new TypeError("仅允许 SELECT、WITH、INSERT、UPDATE 或 DELETE；不允许修改数据库结构");
}

function sqlTokens(sql: string): { words: string[]; semicolon: boolean } {
  const words: string[] = [];
  let semicolon = false;
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      index += 1;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { index += 2; continue; }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "[" ) {
      index = sql.indexOf("]", index + 1);
      index = index === -1 ? sql.length : index + 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      index = sql.indexOf("\n", index + 2);
      index = index === -1 ? sql.length : index + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      index = sql.indexOf("*/", index + 2);
      index = index === -1 ? sql.length : index + 2;
      continue;
    }
    if (char === ";") { semicolon = true; index += 1; continue; }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(index));
    if (match) { words.push(match[0]!.toLowerCase()); index += match[0]!.length; continue; }
    index += 1;
  }
  return { words, semicolon };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function jsonValue(value: SQLOutputValue | undefined): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return `<BLOB ${value.byteLength} bytes>`;
  return value ?? null;
}
