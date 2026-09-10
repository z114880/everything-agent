import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { ToolsPage } from "../src/pages/tools/ToolsPage";

const { useState } = vi.hoisted(() => ({ useState: vi.fn() }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useState }));
beforeEach(() => useState.mockReset());

it.each(["get_current_time", "search_web"])("保存 %s 时另一个开关仍可操作且状态不变", (savingTool) => {
  const catalog = {
    tools: ["get_current_time", "search_web"].map((name) => ({
      name, description: name, origin: "内置", enabled: true, configurable: true, configured: true,
    })),
    tavily: { keyConfigured: true, keyLast4: "1234" },
  };
  const values = [catalog, true, true, "", false, false, new Set([savingTool]), "", ""];
  for (const value of values) useState.mockReturnValueOnce([value, vi.fn()]);
  const html = renderToStaticMarkup(<ToolsPage />);
  const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
  for (const button of switches) {
    expect(button).toContain('aria-checked="true"');
    expect(button.includes('disabled=""')).toBe(button.includes(`aria-label="${savingTool} `));
  }
});
