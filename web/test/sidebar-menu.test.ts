import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const app = fileURLToPath(new URL("../src/App.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("侧栏菜单", () => {
  it("依次展示 Workflow、分割线和 Agent，并使用 Trace 标签", async () => {
    const source = await readFile(app, "utf8");
    const styles = await readFile(styleSheet, "utf8");
    const workflowIndex = source.indexOf("<span>Workflow</span>");
    const dividerIndex = source.indexOf('className="nav-divider"');
    const agentIndex = source.indexOf("<span>Agent</span>");

    expect(workflowIndex).toBeGreaterThan(-1);
    expect(dividerIndex).toBeGreaterThan(workflowIndex);
    expect(agentIndex).toBeGreaterThan(dividerIndex);
    expect(source).not.toContain('className="nav-group"');
    expect(source).not.toContain('className="nav-count"');
    expect(source).toContain("<span>Trace</span>");
    expect(source).not.toContain("<span>运行记录</span>");
    expect(styles).toContain(".nav-divider { height: 1px;");
  });
});
