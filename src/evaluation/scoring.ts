import { isDeepStrictEqual } from "node:util";
import type { EvaluationCase, EvaluationEvidence, EvaluationScore, EvaluationExecution, EvaluationPlan, EvaluationReport } from "./types.ts";

/** 用真实产物和工具结果执行确定性断言；工具失败不能算成功调用。 */
export function scoreAssertions(testCase: EvaluationCase, evidence: EvaluationEvidence): EvaluationScore[] {
  const reply = evidence.replies.at(-1) ?? "";
  return testCase.assertions.map((assertion, index) => {
    let pass: boolean;
    switch (assertion.kind) {
      case "reply_contains": pass = reply.includes(assertion.value); break;
      case "reply_equals": pass = reply === assertion.value; break;
      case "memory_contains": pass = evidence.memory.some((m) => m.content.includes(assertion.value)); break;
      case "memory_absent": pass = evidence.memory.every((m) => !m.content.includes(assertion.value)); break;
      case "file_equals": pass = evidence.files[assertion.path] === assertion.value; break;
      default: {
        const matches = evidence.toolCalls.filter((call) => call.tool === assertion.tool && (assertion.arguments === undefined || isDeepStrictEqual(call.arguments, assertion.arguments)));
        pass = assertion.kind === "tool_forbidden" ? matches.length === 0 : matches.some((call) => !call.isError);
      }
    }
    return { name: `${index + 1}:${assertion.kind}`, status: pass ? "passed" : "failed", score: pass ? 1 : 0, reason: pass ? "断言通过" : "实际执行证据不满足预期" };
  });
}

/** 按预定执行次数统计，缺失执行不从分母移除；评分错误独立于质量失败。 */
export function compareEvaluations(plan: EvaluationPlan, executions: EvaluationExecution[]): EvaluationReport {
  const passed = (e: EvaluationExecution) => e.status === "completed" && e.scores.length > 0 && e.scores.every((s) => s.status === "passed");
  const rate = (caseId: string, variant: string) => executions.filter((e) => e.caseId === caseId && e.variant === variant && passed(e)).length / plan.repetitions;
  const comparisons = plan.dataset.cases.map((c) => {
    const baselineRate = rate(c.id, "baseline"); const candidateRate = rate(c.id, "candidate");
    return { caseId: c.id, baselineRate, candidateRate, change: candidateRate > baselineRate ? "improved" as const : candidateRate < baselineRate ? "regressed" as const : "unchanged" as const };
  });
  const baselineRate = comparisons.reduce((sum, c) => sum + c.baselineRate, 0) / comparisons.length;
  const candidateRate = comparisons.reduce((sum, c) => sum + c.candidateRate, 0) / comparisons.length;
  const agentUsd = total(executions.map((e) => e.evidence?.agentUsd ?? null));
  const judgeUsd = total(executions.map((e) => e.judgeUsd));
  const reasons: string[] = []; let failed = false; let insufficient = false;
  if (agentUsd === null || judgeUsd === null) { insufficient = true; reasons.push("模型用量或价格不完整，无法核实成本"); }
  if (executions.some((e) => e.variant === "candidate" && plan.dataset.cases.find((c) => c.id === e.caseId)?.critical && (e.status === "failed" || e.status === "timed_out" || e.scores.some((s) => s.status === "failed")))) { failed = true; reasons.push("候选版本存在关键用例失败"); }
  if (executions.length !== comparisons.length * plan.repetitions * 2 || executions.some((e) => e.status === "cancelled" || !e.evidence?.complete || e.scores.length === 0 || e.scores.some((s) => s.status === "error"))) { insufficient = true; reasons.push("执行或评分证据不完整"); }
  if (plan.repetitions < plan.gate.minimumRepetitions) { insufficient = true; reasons.push("重复次数未达到门槛"); }
  for (const [cost, budget, name] of [[agentUsd, plan.gate.maxAgentUsd, "Agent"], [judgeUsd, plan.gate.maxJudgeUsd, "评分"]] as const) {
    if (budget !== null && cost === null) { insufficient = true; reasons.push(`${name} 成本未知`); }
    if (budget !== null && cost !== null && cost > budget) { failed = true; reasons.push(`${name} 成本超出预算`); }
  }
  if (!insufficient && (candidateRate < plan.gate.minimumPassRate || baselineRate - candidateRate > plan.gate.maxSuccessRateDrop + 1e-12)) { failed = true; reasons.push("候选通过率或退化幅度不满足门槛"); }
  return { decision: failed ? "failed" : insufficient ? "insufficient" : "passed", reasons, comparisons, baselineRate, candidateRate, agentUsd, judgeUsd };
}
function total(values: (number | null)[]): number | null { return values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0); }
