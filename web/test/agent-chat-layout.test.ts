import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylePath = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("Agent 会话窗口布局", () => {
  it("聊天区保持固定窄宽度且对话列表在内部纵向展开", async () => {
    const css = await readFile(stylePath, "utf8");
    expect(ruleFor(css, ".agent-page-layout")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\) 420px/);
    expect(ruleFor(css, ".agent-chat-dock")).toMatch(/grid-template-columns:\s*minmax\(0, 1fr\)/);
    expect(ruleFor(css, ".session-rail")).toMatch(/max-height:\s*220px/);
    expect(css).not.toContain(".session-rail-collapsed");
    expect(ruleFor(css, ".session-rail[hidden]")).toMatch(/display:\s*none/);
  });

  it("提供始终可用且标明展开状态的对话列表切换按钮", async () => {
    const source = await readFile(new URL("../src/components/AgentPage.tsx", import.meta.url), "utf8");
    expect(source).toContain('[sessionRailCollapsed, setSessionRailCollapsed] = useState(true)');
    expect(source).toContain('hidden={sessionRailCollapsed}');
    const railIndex = source.indexOf('<div id="agent-session-rail"');
    expect(railIndex).toBeGreaterThan(source.indexOf('<div className="agent-dock-header">'));
    expect(railIndex).toBeLessThan(source.indexOf('<div className="agent-chat-log"'));
    expect(source).toContain('aria-expanded={!sessionRailCollapsed}');
    expect(source).toContain('aria-controls="agent-session-rail"');
    expect(source).toContain('setSessionRailCollapsed((collapsed) => !collapsed)');
    expect(source).toContain('sessionRailCollapsed ? "展开对话列表" : "收起对话列表"');
    expect(source.indexOf('aria-controls="agent-session-rail"')).toBeGreaterThan(source.indexOf('<div className="chat-pane">'));
  });

  it("让 Dock 收缩到视口内并把超长会话交给日志区域滚动", async () => {
    const css = await readFile(stylePath, "utf8");

    expect(ruleFor(css, ".agent-chat-dock")).toMatch(/min-height:\s*0\s*;/);
    expect(ruleFor(css, ".agent-chat-dock")).toMatch(/overflow:\s*hidden\s*;/);
    expect(ruleFor(css, ".agent-chat-log")).toMatch(/overflow-y:\s*auto\s*;/);
  });
});

function ruleFor(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  expect(match, `缺少 ${selector} 样式规则`).not.toBeNull();
  return match?.[1] ?? "";
}
