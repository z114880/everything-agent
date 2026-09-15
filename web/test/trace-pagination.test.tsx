// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TracePage } from "../src/pages/trace/TracePage";
import { loadTraces, loadTraceRun } from "../src/agent-api";
vi.mock("../src/agent-api", () => ({ loadTraces: vi.fn(), loadTraceRun: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
it("列表按游标翻页，仅选择运行时读取完整详情", async () => {
  vi.mocked(loadTraces).mockResolvedValueOnce({ runs: [{ runId: "a", startedAt: "today", eventCount: 3000, status: "completed" }], nextCursor: "next" }).mockResolvedValue({ runs: [], nextCursor: null });
  vi.mocked(loadTraceRun).mockResolvedValue({ files: [{ path: "trace.jsonl", records: [{ version: 2, runId: "a", type: "run_started", timestamp: "today" }] }] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<TracePage />));
    expect(loadTraceRun).not.toHaveBeenCalled();
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent?.includes("3000 条"))!.click());
    expect(loadTraceRun).toHaveBeenCalledWith("a"); expect(host.textContent).toContain("run_started");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "下一页")!.click());
    expect(loadTraces).toHaveBeenLastCalledWith("next"); expect(host.textContent).toContain("第 2 页");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
