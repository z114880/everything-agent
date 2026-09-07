import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("配置页布局", () => {
  it("用双列卡片分组模型和检索，全宽展示运行参数，并在窄屏改为单列", async () => {
    const page = await readFile(configPage, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(page).toContain("模型连接");
    expect(page).toContain("Agent Model 与 Small Model 使用完全独立的连接配置");
    expect(page).toContain('aria-label="Agent Model Provider"');
    expect(page).toContain('aria-label="Small Model Provider"');
    expect(page).toContain("Memory Retrieval");
    expect(page).toContain("运行参数");
    expect(page).toContain("<Card");
    expect(page).toContain("<Alert");
    expect(styles).toContain(".config-grid { display: grid; grid-template-columns:");
    expect(styles).toContain(".config-retrieval-card { grid-column: 2; }");
    expect(styles).toContain(".config-runtime-card { grid-column: 1 / -1; }");
    expect(styles).toContain(".config-runtime-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }");
    expect(styles).toContain(".config-grid { grid-template-columns: 1fr; }");
  });

  it("配置、Memory 与 Trace 页面使用和 Agent 主区一致的宽内容布局", async () => {
    const styles = await readFile(styleSheet, "utf8");

    expect(styles).toContain("--page-padding-inline: clamp(20px, 3vw, 46px);");
    expect(styles).toContain(".content-wrap { width: 100%; max-width: none;");
    expect(styles).toContain("padding: var(--page-padding-top) var(--page-padding-inline) var(--page-padding-bottom)");
    expect(styles).toContain(".agent-main-column { min-width: 0; overflow-y: auto; padding: var(--page-padding-top) var(--page-padding-inline) var(--page-padding-bottom);");
  });

  it("在本地配置提示标题后展示本地存储徽标", async () => {
    const page = await readFile(configPage, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(page).toMatch(
      /<AlertTitle className="flex items-center gap-2">\s*配置不会离开当前项目\s*<Badge variant="success"><ShieldCheck size=\{12\} \/>仅存储在本地<\/Badge>\s*<\/AlertTitle>/,
    );
    expect(styles).toContain('.config-local-alert [data-slot="alert-description"] { margin-top: 5px; }');
  });

  it("数字输入允许临时清空，各区域独立保存且顶部双卡片等高", async () => {
    const page = await readFile(configPage, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(page).not.toContain("Number(event.target.value)");
    expect(page).not.toContain("保存全部配置");
    expect(page).not.toContain("保存 Agent Model");
    expect(page).not.toContain("保存 Small Model");
    expect(page).toContain("保存模型连接配置");
    expect(page).toContain("保存检索配置");
    expect(page).toContain("保存运行参数");
    expect(page.indexOf("保存模型连接配置")).toBeLessThan(page.indexOf("<ModelKeysClearDialog"));
    expect(page.indexOf("保存检索配置")).toBeLessThan(page.indexOf("<EmbeddingKeyClearDialog"));
    expect(page).toContain("恢复默认运行值");
    expect(page.indexOf("恢复默认运行值")).toBeLessThan(page.indexOf("{runtimeMessage}"));
    expect(page).toContain("运行配置已恢复默认值；模型连接和 EVERYTHING.md 未修改。");
    expect(page).not.toContain('className="config-field-wide" label="Model Context Window（tokens）"');
    expect(page).toMatch(/<div className="config-index-copy">[\s\S]*"尚未建立索引"[\s\S]*<\/div>\s*<div className="config-index-action">[\s\S]*重建索引[\s\S]*<\/div>/);
    expect(styles).toContain(".config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: stretch; }");
    expect(styles).toContain(".config-card { display: flex; height: 100%; flex-direction: column;");
    expect(styles).toContain(".config-card-content { display: flex; flex: 1; flex-direction: column;");
    expect(styles).toContain(".config-card-actions { position: relative; margin-top: auto; padding-top: 36px; }");
    expect(styles).toContain(".config-card-actions::before { position: absolute; top: 20px;");
    expect(styles).toContain(".config-index-status { display: flex; align-items: center; gap: 20px;");
    expect(styles).toContain(".config-index-action { display: flex; flex: 0 0 auto; align-items: center; }");
  });
});
