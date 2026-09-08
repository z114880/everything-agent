import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseSqlNeedsConfirmation, loadDatabase, runDatabaseSql } from "../src/agent-api";

const pagePath = fileURLToPath(new URL("../src/components/DatabasePage.tsx", import.meta.url));

afterEach(() => vi.unstubAllGlobals());

describe("Database 页面", () => {
  it("读取普通表并在确认后发送写操作令牌", async () => {
    const dashboard = { path: "/tmp/state.db", size: 1, tables: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(dashboard), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: "write", columns: [], rows: [], truncated: false, changes: 1, lastInsertRowid: null }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadDatabase()).resolves.toEqual(dashboard);
    await runDatabaseSql("DELETE FROM sessions WHERE id = 1", true);

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/local-agent/database", undefined);
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      sql: "DELETE FROM sessions WHERE id = 1",
      confirmation: "CONFIRM_DATABASE_WRITE",
    });
  });

  it("识别需要二次确认的数据写语句", () => {
    expect(databaseSqlNeedsConfirmation("SELECT * FROM sessions")).toBe(false);
    expect(databaseSqlNeedsConfirmation("-- 修改标题\nUPDATE sessions SET title = '新标题'")).toBe(true);
    expect(databaseSqlNeedsConfirmation(" /* 清理 */ DELETE FROM sessions")).toBe(true);
  });

  it("页面展示表结构、SQL Console 和写操作确认框", async () => {
    const source = await readFile(pagePath, "utf8");

    expect(source).toContain('title="Database"');
    expect(source).toContain("dashboard.tables.map");
    expect(source).toContain("column.type");
    expect(source).toContain("SQL Console");
    expect(source).toContain("<AlertDialog");
    expect(source).toContain("确认执行数据库写操作？");
    expect(source).toContain("仅允许单条语句，最多返回 200 行；不允许 DDL");
  });
});
