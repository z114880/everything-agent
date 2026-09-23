import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("../src/App.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("侧栏菜单", () => {
  it("依次展示 Workflow、分割线、Agent、Skills、Tools 与 Database，并使用 Trace 标签", async () => {
    const source = await readFile(app, "utf8");
    const styles = await readFile(styleSheet, "utf8");
    const workflowIndex = source.indexOf("<span>Workflow</span>");
    const dividerIndex = source.indexOf('className="nav-divider"');
    const agentIndex = source.indexOf("<span>Agent</span>");
    const skillsIndex = source.indexOf("<span>Skills</span>");
    const toolsIndex = source.indexOf("<span>Tools</span>");
    const databaseIndex = source.indexOf("<span>Database</span>");

    expect(workflowIndex).toBeGreaterThan(-1);
    expect(dividerIndex).toBeGreaterThan(workflowIndex);
    expect(agentIndex).toBeGreaterThan(dividerIndex);
    expect(skillsIndex).toBeGreaterThan(agentIndex);
    expect(toolsIndex).toBeGreaterThan(skillsIndex);
    expect(databaseIndex).toBeGreaterThan(toolsIndex);
    expect(source).not.toContain('className="nav-group"');
    expect(source).not.toContain('className="nav-count"');
    expect(source).toContain("<span>Trace</span>");
    expect(source).not.toContain("<span>运行记录</span>");
    expect(styles).toContain(".nav-divider { height: 1px;");
  });

  it("保持所有菜单项的图标与文字左对齐", async () => {
    const styles = await readFile(styleSheet, "utf8");

    expect(styles).toContain("justify-content: flex-start");
    expect(styles).toContain(".nav-item > svg { width: 17px; height: 17px;");
    expect(styles).not.toContain(".nav-item.active::before");
  });

  it("左右侧栏使用同款折叠按钮并以相反方向提示开合", async () => {
    const source = await readFile(app, "utf8");
    const agentSource = await readFile(new URL("../src/pages/agent/AgentPage.tsx", import.meta.url), "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(source).toContain('className="panel-collapse-toggle sidebar-toggle"');
    expect(source).toContain('<ChevronLeft size={16} />');
    expect(source).toContain('className="panel-collapse-toggle sidebar-reopen"');
    expect(source).toContain('<ChevronRight size={16} />');
    expect(source).not.toContain("PanelLeftClose");
    expect(source).not.toContain("PanelLeftOpen");
    expect(agentSource).toContain('className="panel-collapse-toggle chat-collapse-toggle"');
    expect(styles).toContain(".panel-collapse-toggle { display: grid;");
    expect(styles).toContain("border: 1px solid transparent; border-radius: 7px; background: transparent;");
    expect(styles).toContain(".panel-collapse-toggle:hover { border-color: var(--line); background: #ffffffb8;");
    expect(styles).toContain(".panel-collapse-toggle.sidebar-reopen { position: fixed;");
    // 与聊天区收起后的展开按钮共用同一条水平线与同一条边缘留白。
    expect(styles).toContain("top: var(--panel-toggle-top); left: var(--panel-toggle-inset);");
    expect(source).toContain('id="app-sidebar"');
    expect(source).toContain('aria-controls="app-sidebar"');
    expect(source).toContain("aria-expanded={sidebarOpen}");
  });

  it("品牌文字样式不会偏移收起按钮内的箭头", async () => {
    const source = await readFile(app, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(source).toContain('<div className="brand-copy">');
    expect(styles).toContain(".brand-copy span { display: block;");
    expect(styles).not.toContain(".brand-row span {");
  });
});
