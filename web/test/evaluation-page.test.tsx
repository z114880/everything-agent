// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EvaluationPage } from "../src/pages/evaluation/EvaluationPage";
import { DatasetEditor } from "../src/pages/evaluation/DatasetEditor";
import { evaluationPlayback } from "../src/evaluation-playback";
import * as api from "../src/evaluation-api";
import { starterDatasets, type EvaluationRun, type DatasetSnapshot } from "../../src/evaluation/index.ts";
vi.mock("../src/evaluation-api", () => ({ evaluationOverview: vi.fn(), evaluationDataset: vi.fn(), initializeEvaluationDatasets: vi.fn(), saveEvaluationDataset: vi.fn(), startEvaluation: vi.fn(), getEvaluation: vi.fn(), cancelEvaluation: vi.fn(), refreshEvaluationScores: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); });
const dataset: DatasetSnapshot = { ...starterDatasets()[0]!, remoteName: "remote", remoteId: "remote-id", version: "2026-09-16T00:00:00Z", count: 8, url: "https://example.com/dataset", itemIds: {} };
const model = { provider: "openai-compatible" as const, model: "current-agent", baseUrl: "https://example.com", apiKeyEnv: "MODEL_KEY" };
const run: EvaluationRun = { id: "run", createdAt: dataset.version, updatedAt: dataset.version, status: "waiting_scores", stage: "score", datasets: [dataset], configuration: { agent: model, small: model, systemPrompt: "", maxIterations: 10, maxTokens: 2048, modelContextWindow: 32768, skills: [], retrieval: { mode: "lexical_only", embedding: null, minimumSimilarity: 0.3 } }, codeHash: "hash", executions: [], report: { decision: "insufficient", passed: 0, failed: 0, pending: 8, total: 8, reasons: ["执行或评分尚未完整"] }, error: null };
function overview(active = false): api.EvaluationOverview { return { datasets: [dataset], runs: [run], active: active ? run : null, langfuse: { configured: true, captureContent: true, url: "https://example.com/project" } }; }
it("Overview 以固定数据集和 Langfuse 为中心，运行当前 Agent 并展示等待评分", async () => {
  vi.mocked(api.evaluationOverview).mockResolvedValue(overview()); vi.mocked(api.startEvaluation).mockResolvedValue({ id: "run" }); vi.mocked(api.getEvaluation).mockResolvedValue(run);
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<EvaluationPage />));
    expect(host.textContent).toContain("固定数据集"); expect(host.textContent).toContain("Langfuse"); expect(host.textContent).not.toContain("新建实验"); expect(host.textContent).not.toContain("基线");
    await act(async () => button("Evaluate 默认数据集").click()); expect(api.startEvaluation).toHaveBeenCalledWith(undefined);
    expect(host.textContent).toContain("评估结果 · 证据不足"); expect(host.textContent).toContain("等待评分"); expect(host.textContent).not.toContain("人工复核");
    vi.mocked(api.refreshEvaluationScores).mockResolvedValue({ ...run, status: "completed", report: { ...run.report, decision: "passed", passed: 8, pending: 0 } });
    await act(async () => button("刷新评分与同步").click()); expect(api.refreshEvaluationScores).toHaveBeenCalledWith("run"); expect(host.textContent).toContain("评估结果 · 通过");
    await act(async () => button("数据集").click());
    vi.mocked(api.evaluationDataset).mockResolvedValue(dataset);
    await act(async () => button("浏览与编辑").click()); expect(api.evaluationDataset).toHaveBeenCalledWith(dataset.id);
    expect(host.querySelector('[aria-label="数据集名称"]')).not.toBeNull();
    vi.mocked(api.saveEvaluationDataset).mockResolvedValue(dataset);
    await act(async () => button("保存数据集").click()); expect(api.saveEvaluationDataset).toHaveBeenCalled();
    expect(host.querySelector('[aria-label="数据集编辑"]')).toBeNull();
  } finally { await act(async () => root.unmount()); host.remove(); }
});
it("运行中不能重复创建，取消调用现有运行，连接失败明确展示", async () => {
  vi.mocked(api.evaluationOverview).mockResolvedValue(overview(true)); vi.mocked(api.getEvaluation).mockResolvedValue({ ...run, status: "running" }); vi.mocked(api.cancelEvaluation).mockResolvedValue({ cancelled: true });
  const host = document.createElement("div"); const root = createRoot(host); const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<EvaluationPage />)); expect(button("Evaluate 默认数据集").disabled).toBe(true);
    await act(async () => button("查看结果与失败详情").click());
    await act(async () => button("取消评估").click()); expect(api.cancelEvaluation).toHaveBeenCalledWith("run");
    await act(async () => button("Overview").click()); vi.mocked(api.evaluationOverview).mockRejectedValueOnce(new Error("Langfuse 不可用"));
    await act(async () => button("刷新连接与概览").click()); expect(host.querySelector('[role="alert"]')?.textContent).toContain("Langfuse 不可用");
  } finally { await act(async () => root.unmount()); }
});
it("用例编辑可增删轮次和检查，非法 JSON 不会悄悄保存旧值", async () => {
  const host = document.createElement("div"); const root = createRoot(host); const save = vi.fn(async () => {});
  const button = (text: string) => [...host.querySelectorAll("button")].find(b => b.textContent?.trim() === text)!;
  try {
    await act(async () => root.render(<DatasetEditor initial={dataset} busy={false} onSave={save} onClose={vi.fn()} />));
    await act(async () => button("添加轮次").click()); expect(host.querySelector('[aria-label="第 2 轮输入"]')).not.toBeNull();
    await act(async () => button("添加检查").click()); expect(host.querySelectorAll('select')).toHaveLength(3);
    await act(async () => button("添加用例").click()); expect((host.querySelector('[aria-label="用例名称"]') as HTMLInputElement).value).toBe("新用例");
    const textarea = host.querySelector('[aria-label="初始文件"]') as HTMLTextAreaElement;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "{"); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
    await act(async () => button("保存数据集").click()); expect(save).not.toHaveBeenCalled(); expect(host.textContent).toContain("JSON 格式");
  } finally { await act(async () => root.unmount()); }
});
it("流程图仅按实际阶段事件变化，失败与取消不显示通过", () => {
  const base = { runId: "run", timestamp: "2026-09-16", status: "running" as const, decision: "insufficient" as const };
  const events: api.EvaluationEvent[] = [ { ...base, type: "dataset_ready", stage: "dataset", sequence: 1 }, { ...base, type: "agent_started", stage: "agent", sequence: 2 }, { ...base, type: "scoring_started", stage: "score", sequence: 3 } ];
  expect(evaluationPlayback(events).states).toMatchObject({ evaluate_dataset: "done", evaluate_agent: "done", evaluate_score: "running", evaluate_gate: "idle" });
  expect(evaluationPlayback([...events, { ...base, type: "gate_completed", stage: "gate", sequence: 4, decision: "failed" }]).states.evaluate_gate).toBe("error");
  expect(evaluationPlayback([...events, { ...base, type: "run_cancelled", stage: "score", sequence: 4 }]).states.evaluate_score).toBe("error");
});
