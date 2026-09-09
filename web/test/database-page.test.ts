import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { databaseSqlNeedsConfirmation, loadDatabase, runDatabaseSql } from "../src/agent-api";

const pagePath = fileURLToPath(new URL("../src/pages/database/DatabasePage.tsx", import.meta.url));
const stylePath = fileURLToPath(new URL("../src/index.css", import.meta.url));

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

  it("页面只展示 Overview 与 SQL Console 两个顶层标签，并从 Overview 下钻表详情", async () => {
    const source = await readFile(pagePath, "utf8");

    expect(source).toContain('title="Database"');
    expect(source).toContain("dashboard.tables.map");
    expect(source).toContain("setSelectedTableName");
    expect(source).toContain("返回 Overview");
    expect(source).toContain("column.type");
    expect(source).toContain("SQL Console");
    expect(source).not.toContain("tab === table.name");
    expect(source).toContain("<AlertDialog");
    expect(source).toContain("确认执行数据库写操作？");
    expect(source).toContain("仅允许单条语句，最多返回 200 行；不允许 DDL");
    expect(source).toContain('if (await reload(MINIMUM_FEEDBACK_DURATION_MS)) setSaveMessage("已刷新")');
    expect(source).toContain("loading={refreshing}");
    expect(source).not.toContain("loading={loading}");
    expect(source).toContain("onClick={() => void refresh()}");
    expect(source).toContain("<SaveMessage message={saveMessage} setMessage={setSaveMessage} />");
  });

  it("切换顶层标签时保持文字宽度稳定", async () => {
    const styles = await readFile(stylePath, "utf8");
    const defaultRule = styles.match(/\.database-tabs button \{([^}]*)\}/)?.[1] ?? "";
    const activeRule = styles.match(/\.database-tabs button\.active \{([^}]*)\}/)?.[1] ?? "";

    expect(defaultRule).toContain("font-weight: 650");
    expect(activeRule).not.toContain("font-weight");
  });

  it("SQL 编辑区域使用 DataGrip 风格的深色配色", async () => {
    const styles = await readFile(stylePath, "utf8");
    const editorRule = styles.match(/\.database-query-editor textarea \{([^}]*)\}/)?.[1] ?? "";
    const focusRule = styles.match(/\.database-query-editor textarea:focus \{([^}]*)\}/)?.[1] ?? "";
    const selectionRule = styles.match(/\.database-query-editor textarea::selection \{([^}]*)\}/)?.[1] ?? "";

    expect(editorRule).toContain("background: #2b2b2b");
    expect(editorRule).toContain("color: #c9ced4");
    expect(editorRule).toContain("caret-color: #ffffff");
    expect(focusRule).toContain("#4b6eaf");
    expect(selectionRule).toContain("background: #214283");
  });
});
