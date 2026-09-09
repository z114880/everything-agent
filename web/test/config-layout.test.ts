import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/pages/config/ConfigPage.tsx", import.meta.url));
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
      /<AlertTitle className="flex items-center gap-2">\s*配置仅存储在当前项目中，不会上传或共享\s*<Badge\s+variant="success">\s*<ShieldCheck size=\{12\} \/>\s*仅存储在本地\s*<\/Badge>\s*<\/AlertTitle>/,
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
    expect(page).toMatch(/variant="secondary"\s+loading=\{resettingRuntime\}/);
    expect(page).not.toContain("runtimeMessage");
    expect(page).toContain('setSaveMessage("运行配置已恢复默认值。")');
    expect(page).toContain("运行配置已恢复默认值。");
    expect(page).not.toContain('className="config-field-wide" label="Model Context Window（tokens）"');
    expect(page).toMatch(/<div className="config-index-copy">[\s\S]*"尚未建立索引"[\s\S]*<\/div>\s*<div className="config-index-action">[\s\S]*重建索引[\s\S]*<\/div>/);
    expect(page).toContain('loading={rebuildingEmbedding}');
    expect(page).toContain("withMinimumDuration(rebuildEmbeddingIndex)");
    expect(styles).toContain(".config-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: stretch; }");
    expect(styles).toContain(".config-card { display: flex; height: 100%; flex-direction: column;");
    expect(styles).toContain(".config-card-content { display: flex; flex: 1; flex-direction: column;");
    expect(styles).toContain(".config-card-actions { position: relative; margin-top: auto; padding-top: 36px; }");
    expect(styles).toContain(".config-card-actions::before { position: absolute; top: 20px;");
    expect(styles).toMatch(/\.config-index-status\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;/);
    expect(styles).toMatch(/\.config-index-action\s*\{[^}]*display:\s*flex;[^}]*flex:\s*0 0 auto;[^}]*align-items:\s*center;/);
  });

  it("索引状态文案样式不会污染重建按钮内部元素", async () => {
    const styles = await readFile(styleSheet, "utf8");

    expect(styles).toContain(".config-index-copy > strong, .config-index-copy > span { display: block; }");
    expect(styles).not.toContain(".config-index-status strong, .config-index-status span");
  });

  it("配置保存和数据清理成功后都使用与 Tools 页面一致的顶部 message", async () => {
    const page = await readFile(configPage, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(page).toContain('const [saveMessage, setSaveMessage] = useState("")');
    expect(page).toContain('setSaveMessage(`${sectionLabel(section)}保存成功，下一回合立即生效。`)');
    expect(page).toContain("setClearMessage(\"\");");
    expect(page).toContain("清理完成。数据库、会话、记忆和运行记录已删除");
    expect(page).toMatch(/if \(result\.embeddingRebuild\)[\s\S]*?setClearMessage\(""\);[\s\S]*?setSaveMessage\([\s\S]*?向量索引已自动重建/);
    expect(page).toMatch(/else \{\s*setClearMessage\(""\);\s*setSaveMessage\([\s\S]*?数据库、会话、记忆和运行记录已删除/);
    expect(page).toContain('<SaveMessage message={saveMessage} setMessage={setSaveMessage} />');
    expect(page).not.toContain('window.setTimeout(() => setSaveMessage(""), 2_500)');
    expect(page).not.toContain("连接测试返回");
    expect(styles).toContain(".save-message, .skills-message, .tools-toast { position: fixed; top: 20px; left: 50%;");
    expect(styles).toContain("animation: tools-toast-lifecycle 2.5s ease both;");
  });
});
