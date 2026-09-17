// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import { TracePage } from "../src/pages/trace/TracePage";
import { loadTraces, loadTraceRun } from "../src/agent-api";
vi.mock("../src/agent-api", () => ({ loadTraces: vi.fn(), loadTraceRun: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
beforeEach(() => vi.resetAllMocks());
it("列表按游标翻页并直接展示原有可折叠 JSONL 文件", async () => {
  vi.mocked(loadTraces).mockResolvedValueOnce({ runs: [{ runId: "a", startedAt: "today", eventCount: 3000, status: "completed" }], nextCursor: "next" }).mockResolvedValue({ runs: [], nextCursor: null });
  vi.mocked(loadTraceRun).mockResolvedValue({ files: [{ path: "trace.jsonl", records: [{ version: 2, runId: "a", type: "run_started", timestamp: "today" }] }] });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<TracePage />));
    expect(host.querySelector(".trace-file-list > details.trace-file[open] strong")?.textContent).toBe("trace.jsonl");
    expect(host.querySelector("details.trace-record")?.hasAttribute("open")).toBe(false);
    expect([...host.querySelectorAll("button")].some((b) => b.textContent?.includes("3000 条"))).toBe(false);
    expect(loadTraceRun).toHaveBeenCalledWith("a"); expect(host.textContent).toContain("run_started");
    await act(async () => [...host.querySelectorAll("button")].find((b) => b.textContent === "下一页")!.click());
    expect(loadTraces).toHaveBeenLastCalledWith("next"); expect(host.textContent).toContain("第 2 页");
  } finally { await act(async () => root.unmount()); host.remove(); }
});


it("当前页自动合并文件，关联事件去重并保持原有文件与事件顺序", async () => {
  vi.mocked(loadTraces).mockResolvedValue({ runs: ["a", "b"].map((runId) => ({ runId, startedAt: "today", eventCount: 2, status: "completed" })), nextCursor: null });
  const record = { version: 2, runId: "a", eventId: "shared", type: "run_started", timestamp: "2026-09-16T01:00:00" };
  vi.mocked(loadTraceRun).mockResolvedValueOnce({ files: [
    { path: "2026-09-16/2-run.jsonl", records: [record] },
    { path: "2026-09-16/10-run.jsonl", records: [{ ...record, eventId: "later" }] },
  ] }).mockResolvedValueOnce({ files: [{ path: "2026-09-16/2-run.jsonl", records: [record, { ...record, eventId: "earlier", timestamp: "2026-09-16T00:00:00" }] }] });
  const host = document.createElement("div"); const root = createRoot(host);
  try {
    await act(async () => root.render(<TracePage />));
    expect(loadTraceRun).toHaveBeenCalledTimes(2);
    expect([...host.querySelectorAll(".trace-file-summary strong")].map((node) => node.textContent)).toEqual(["2026-09-16/10-run.jsonl", "2026-09-16/2-run.jsonl"]);
    const records = host.querySelectorAll(".trace-file")[1]!.querySelectorAll(".trace-record");
    expect(records).toHaveLength(2);
    expect(records[0]!.textContent).toContain("earlier");
  } finally { await act(async () => root.unmount()); host.remove(); }
});

it("翻页详情失败时保留当前页，重试成功后支持返回上一页", async () => {
  const page = { runs: [{ runId: "a", startedAt: "today", eventCount: 1, status: "completed" }], nextCursor: "next" };
  vi.mocked(loadTraces).mockResolvedValueOnce(page).mockResolvedValueOnce({ ...page, nextCursor: null }).mockResolvedValueOnce({ ...page, nextCursor: null }).mockResolvedValue(page);
  vi.mocked(loadTraceRun).mockResolvedValueOnce({ files: [{ path: "first.jsonl", records: [] }] }).mockRejectedValueOnce(new Error("详情读取失败")).mockResolvedValue({ files: [{ path: "second.jsonl", records: [] }] });
  const host = document.createElement("div"); const root = createRoot(host);
  const button = (label: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === label)!;
  try {
    await act(async () => root.render(<TracePage />));
    await act(async () => button("下一页").click());
    expect(host.textContent).toContain("第 1 页");
    expect(host.textContent).toContain("first.jsonl");
    expect(host.querySelector('[role="alert"]')?.textContent).toBe("详情读取失败");
    await act(async () => button("下一页").click());
    expect(host.textContent).toContain("第 2 页");
    expect(host.textContent).not.toContain("first.jsonl");
    expect(button("下一页").disabled).toBe(true);
    await act(async () => button("上一页").click());
    expect(loadTraces).toHaveBeenLastCalledWith(undefined);
    expect(host.textContent).toContain("第 1 页");
    expect(button("上一页").disabled).toBe(true);
  } finally { await act(async () => root.unmount()); host.remove(); }
});
