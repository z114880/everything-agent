import type { EvaluationPlan } from "./types.ts";
/** 不包含凭证的起始配置，用户填写本地源码目录和模型连接后执行。 */
export function exampleEvaluationPlan(sourceRoot: string): EvaluationPlan {
  const model = { provider: "openai-compatible" as const, model: "填写模型名称", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "EVALUATION_MODEL_API_KEY" };
  const variant = { name: "基线", sourceRoot, systemPrompt: "你是个人助理，使用中文回答。", agent: model, small: model, maxIterations: 10, maxTokens: 2048, modelContextWindow: 32768, skills: [], retrieval: { mode: "lexical_only" as const, embedding: null, minimumSimilarity: 0.3 } };
  return {
    name: "个人助理回归", dataset: { name: "基础能力", version: "1", cases: [{ id: "current-time", name: "使用工具获取当前时间", critical: true, turns: ["现在的日期是什么？"], history: [], memory: [], files: {}, tools: [{ name: "get_current_time", arguments: {}, result: { iso: "2026-09-15T00:00:00Z", timeZone: "UTC", local: "2026年9月15日" } }], assertions: [{ kind: "tool_called", tool: "get_current_time" }, { kind: "reply_contains", value: "2026" }], expectedOutput: "当前日期是2026年9月15日", criteria: "" }] },
    baseline: variant, candidate: { ...variant, name: "候选" }, repetitions: 3, timeoutMs: 300000, judge: null,
    gate: { maxSuccessRateDrop: 0, minimumPassRate: 1, minimumRepetitions: 3, maxAgentUsd: null, maxJudgeUsd: null, judgeThreshold: 0.8 },
  };
}
