// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { MemoryPage } from "../src/pages/memory/MemoryPage";
import { RUNTIME_SYSTEM_PROMPT } from "../../src/agent-runtime/system-prompt.ts";

const api = vi.hoisted(() => ({ loadAgent: vi.fn(), loadMemory: vi.fn(), memoryAction: vi.fn(), saveSystemPrompt: vi.fn() }));
vi.mock("../src/agent-api", () => api);

it("Consolidation 后展示只读运行时提示词，不混入用户规则或提供保存入口", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.loadAgent.mockResolvedValue({ systemPrompt: "用户专属规则" });
  api.loadMemory.mockResolvedValue({ overview: {}, semantic: [], consolidations: [] });
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryPage />));
    const tabs = [...container.querySelectorAll(".memory-tabs button")];
    expect(tabs.slice(-2).map((button) => button.textContent)).toEqual(["Consolidation", "System Prompt"]);
    await act(async () => (tabs.at(-1) as HTMLButtonElement).click());
    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe(RUNTIME_SYSTEM_PROMPT);
    expect(textarea.readOnly).toBe(true);
    expect(textarea.closest(".procedural-editor")).not.toBeNull();
    expect(container.textContent).not.toContain("用户专属规则");
    expect(container.querySelector("textarea:not([readonly]), input, [contenteditable=true]")).toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.includes("保存"))).toBe(false);
    expect(api.saveSystemPrompt).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
