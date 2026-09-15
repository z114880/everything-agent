// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { EvaluationPage } from "../src/pages/evaluation/EvaluationPage";
import * as api from "../src/evaluation-api";
import { exampleEvaluationPlan } from "../../src/evaluation/example.ts";

vi.mock("../src/evaluation-api", () => ({ listEvaluations: vi.fn(), getEvaluation: vi.fn(), startEvaluation: vi.fn(), cancelEvaluation: vi.fn(), reviewEvaluation: vi.fn() }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.clearAllMocks(); });

it("新建实验显示可编辑配置，创建后显示比较与完整证据入口", async () => {
  vi.mocked(api.listEvaluations).mockResolvedValue({ items: [], page: 1, total: 0, sourceRoot: "/project" });
  const plan = exampleEvaluationPlan("/project");
  vi.mocked(api.startEvaluation).mockResolvedValue({ id: "experiment" });
  vi.mocked(api.getEvaluation).mockResolvedValue({ id: "experiment", createdAt: "today", plan, status: "completed", fingerprint: "hash", codeHashes: { baseline: "a", candidate: "b" }, scorerVersion: "v1", executions: [], reviews: [], error: null, report: { decision: "insufficient", reasons: ["执行不完整"], baselineRate: 0, candidateRate: 0, agentUsd: null, judgeUsd: 0, comparisons: [{ caseId: "current-time", baselineRate: 0, candidateRate: 0, change: "unchanged" }] } });
  const host = document.createElement("div"); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<EvaluationPage />));
    const button = (label: string) => [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
    await act(async () => button("新建实验").click());
    const textarea = host.querySelector<HTMLTextAreaElement>('[aria-label="实验 JSON"]')!;
    expect(JSON.parse(textarea.value).baseline.sourceRoot).toBe("/project");
    await act(async () => button("创建并运行").click());
    expect(api.startEvaluation).toHaveBeenCalledWith(expect.objectContaining({ dataset: expect.objectContaining({ version: "1" }) }));
    expect(host.textContent).toContain("发布门槛：证据不足");
    expect(host.textContent).toContain("Agent 成本：未知");
    await act(async () => button("current-time").click());
    expect(host.textContent).toContain("保存复核");
    expect(host.textContent).toContain("整理为回归实验");
  } finally { await act(async () => root.unmount()); host.remove(); }
});
