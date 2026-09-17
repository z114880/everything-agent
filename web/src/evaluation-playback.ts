import type { EvaluationEvent } from "./evaluation-api";
import type { VisualNodeState } from "./visual-node-state";

const stages = ["dataset", "agent", "score", "gate"] as const;
/** 只消费已落盘的评估事件，不根据最终回答推测过程。 */
export function evaluationPlayback(events: EvaluationEvent[]) {
  const states: Record<string, VisualNodeState> = Object.fromEntries(stages.map(stage => [`evaluate_${stage}`, "idle"]));
  const edges = new Set<string>();
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const node = `evaluate_${event.stage}`;
    if (event.type === "dataset_ready") states.evaluate_dataset = "done";
    if (event.type === "agent_started") { states.evaluate_agent = "running"; edges.clear(); edges.add("evaluate_dataset->evaluate_agent"); }
    if (event.type === "scoring_started") { states.evaluate_agent = "done"; states.evaluate_score = "running"; edges.clear(); edges.add("evaluate_agent->evaluate_score"); }
    if (event.type === "gate_completed") { states.evaluate_score = "done"; states.evaluate_gate = event.decision === "passed" ? "done" : "error"; edges.clear(); edges.add("evaluate_score->evaluate_gate"); }
    if (["run_failed", "run_cancelled", "scores_failed"].includes(event.type)) { states[node] = "error"; edges.clear(); }
    if (event.type === "scores_pending") states.evaluate_score = "running";
  }
  return { states, edges };
}
