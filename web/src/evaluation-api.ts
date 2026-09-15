import type { EvaluationExperiment, EvaluationPlan } from "../../src/evaluation/types";
export type { EvaluationExperiment, EvaluationPlan };
const endpoint = "/api/local-agent/evaluation";
export interface EvaluationList { total: number; page: number; sourceRoot: string; items: { id: string; name: string; status: string; completed: number; total: number; decision: string | null }[] }
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error ?? "评估请求失败"); return result as T;
}
export function listEvaluations(page = 1) { return request<EvaluationList>(`${endpoint}?page=${page}`); }
export function getEvaluation(id: string) { return request<EvaluationExperiment>(`${endpoint}?id=${encodeURIComponent(id)}`); }
export function startEvaluation(plan: unknown) { return request<{ id: string }>(endpoint, { plan }); }
export function cancelEvaluation(id: string) { return request(endpoint, { action: "cancel", id }); }
export function reviewEvaluation(id: string, caseId: string, conclusion: string) { return request<EvaluationExperiment>(endpoint, { action: "review", id, caseId, conclusion }); }
