import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylePath = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("Agent 会话窗口布局", () => {
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
