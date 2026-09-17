// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi, afterEach } from "vitest";
import { useEvaluation } from "../src/pages/agent/useEvaluation";
import * as api from "../src/evaluation-api";
vi.mock("../src/evaluation-api", () => ({ evaluationOverview: vi.fn(), evaluationEvents: vi.fn(), startEvaluation: vi.fn(), cancelEvaluation: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
function Controls() { const evaluation = useEvaluation(); return <><button disabled={evaluation.busy} onClick={() => void evaluation.start()}>Evaluate</button><button onClick={() => void evaluation.cancel()}>取消</button><output>{JSON.stringify({ status: evaluation.status, error: evaluation.error, states: evaluation.states })}</output></>; }
it("Agent Evaluate 使用默认集，按持久化事件更新独立节点并支持取消", async () => {
  vi.useFakeTimers();
  const idle: api.EvaluationOverview = { datasets: [], runs: [], active: null, langfuse: { configured: true, captureContent: true, url: null } };
  const summary = { id: "run", createdAt: "2026-09-16", status: "running" as const, stage: "agent" as const, report: { decision: "insufficient" as const, total: 1, passed: 0, failed: 0, pending: 1, reasons: [] }, error: null };
  vi.mocked(api.evaluationOverview).mockResolvedValue(idle); vi.mocked(api.evaluationEvents).mockResolvedValue([]); vi.mocked(api.startEvaluation).mockResolvedValue({ id: "run" }); vi.mocked(api.cancelEvaluation).mockResolvedValue({ cancelled: true });
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<Controls />));
    vi.mocked(api.evaluationOverview).mockResolvedValue({ ...idle, active: summary });
    await act(async () => host.querySelectorAll("button")[0]!.click()); expect(api.startEvaluation).toHaveBeenCalledWith();
    vi.mocked(api.evaluationEvents).mockResolvedValue([{ runId: "run", sequence: 1, timestamp: "2026-09-16", type: "agent_started", stage: "agent", status: "running", decision: "insufficient" }]);
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(host.textContent).toContain('"evaluate_agent":"running"'); expect(host.textContent).toContain("评估中");
    await act(async () => host.querySelectorAll("button")[1]!.click()); expect(api.cancelEvaluation).toHaveBeenCalledWith("run");
    vi.mocked(api.startEvaluation).mockRejectedValueOnce(new Error("没有默认数据集"));
    await act(async () => host.querySelectorAll("button")[0]!.click()); expect(host.textContent).toContain("没有默认数据集");
  } finally { await act(async () => root.unmount()); }
});
