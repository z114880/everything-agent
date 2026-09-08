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
});
