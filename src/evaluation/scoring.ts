import { isDeepStrictEqual } from "node:util";
import type { EvaluationCase, EvaluationEvidence, EvaluationScore, EvaluationExecution, EvaluationRun, EvaluationReport } from "./types.ts";

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

/** 所有预定用例都进入分母；缺少评分或不完整执行绝不通过，费用仅供展示。 */
export function summarizeRun(run: Pick<EvaluationRun, "datasets" | "executions" | "status">): EvaluationReport {
  let passed = 0, failed = 0, pending = 0;
  for (const dataset of run.datasets) for (const testCase of dataset.cases) {
    const e = run.executions.find(item => item.datasetId === dataset.id && item.caseId === testCase.id);
    if (!e) { pending++; continue; }
    if (e.status === "failed" || e.status === "timed_out" || e.scores.some(s => s.status === "failed")) { failed++; continue; }
    const expected = testCase.assertions.length + (testCase.judge ? 1 : 0);
    if (e.status !== "completed" || !e.evidence?.complete || e.sync !== "synced" || e.scores.length !== expected || e.scores.some(s => s.status !== "passed")) pending++;
    else passed++;
  }
  const total = passed + failed + pending;
  const incomplete = run.status !== "completed" || total === 0 || pending > 0;
  return { decision: failed ? "failed" : incomplete ? "insufficient" : "passed", passed, failed, pending, total,
    reasons: [...(failed ? ["存在未通过的用例"] : []), ...(incomplete ? ["执行、同步或评分尚未完整"] : [])] };
}
