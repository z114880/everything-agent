import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const memoryPage = fileURLToPath(new URL("../src/pages/memory/MemoryPage.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("Memory 页面布局", () => {
  it("把刷新操作放在统一页面头部的副标题后", async () => {
    const [page, styles] = await Promise.all([
      readFile(memoryPage, "utf8"),
      readFile(styleSheet, "utf8"),
    ]);

    expect(page).toMatch(/<PageHeading eyebrow="SQLite \/ Lexical \+ Dense" title="Memory" description="Semantic Memory、Session Recall、会话日志与整理状态。" descriptionActions=\{<Button size="sm" className="memory-refresh"[^\n]*刷新数据/);
    expect(page).not.toContain('<Button variant="outline" size="sm" className="memory-refresh"');
    expect(styles).toContain(".page-heading-description { display: flex; align-items: center;");
    expect(styles).toContain(".page-heading-description-actions { display: flex; align-items: center; margin-top: 7px; }");
    expect(styles).toContain(".memory-refresh { flex: 0 0 auto;");
    expect(page).toContain('if (await reload(MINIMUM_FEEDBACK_DURATION_MS)) setSaveMessage("已刷新")');
    expect(page).toContain("onClick={() => void refresh()}");
    expect(page).toContain("<SaveMessage message={saveMessage} setMessage={setSaveMessage} />");
  });

  it("切换标签时保持标签宽度稳定", async () => {
    const styles = await readFile(styleSheet, "utf8");

    expect(styles).toMatch(/\.memory-tabs button \{[^}]*font-weight: 650;/);
    expect(styles).not.toMatch(/\.memory-tabs button\.active \{[^}]*font-weight:/);
  });

  it("把 Semantic 和 Episodic 的搜索图标放在输入框内", async () => {
    const [page, styles] = await Promise.all([
      readFile(memoryPage, "utf8"),
      readFile(styleSheet, "utf8"),
    ]);

    expect(page).toMatch(/<div className="memory-search-field"><Search size=\{15\} aria-hidden="true" \/><Input/);
    expect(styles).toContain(".memory-search-field { position: relative; min-width: 0; flex: 1; }");
    expect(styles).toContain(".memory-search-field > svg { position: absolute;");
    expect(styles).toMatch(/\.memory-search-field input \{[^}]*width: 100%;[^}]*padding-left:/);
  });
});
