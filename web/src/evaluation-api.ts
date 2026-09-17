import type { DatasetReference, DatasetSnapshot, EvaluationDataset, EvaluationEvent, EvaluationOverview, EvaluationRun } from "../../src/evaluation/types";
export type { EvaluationCase, EvaluationDataset, EvaluationRun, EvaluationOverview, EvaluationEvent } from "../../src/evaluation/types";
const endpoint = "/api/local-agent/evaluation";
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "评估请求失败");
  return value as T;
}
/** 读取数据集与运行摘要，详情按需加载。 */
export function evaluationOverview() { return request<EvaluationOverview>(endpoint); }
/** 从 Langfuse 读取当前固定版本的用例。 */
export function evaluationDataset(id: string) { return request<DatasetSnapshot>(`${endpoint}?datasetId=${encodeURIComponent(id)}`); }
/** 保存数据集的新版本，旧运行保持原始快照。 */
export function saveEvaluationDataset(dataset: EvaluationDataset) { return request<DatasetReference>(endpoint, { action: "save_dataset", dataset }); }
/** 显式建立个人助理默认用例，不覆盖已有数据集。 */
export function initializeEvaluationDatasets() { return request<DatasetReference[]>(endpoint, { action: "initialize" }); }
/** 不传 ID 时运行默认数据集，参数不接受模型或源码路径。 */
export function startEvaluation(datasetIds?: string[]) { return request<{ id: string }>(endpoint, { action: "start", datasetIds }); }
/** 读取完整运行证据。 */
export function getEvaluation(id: string) { return request<EvaluationRun>(`${endpoint}?id=${encodeURIComponent(id)}`); }
/** 读取服务落盘的有序事件，用于流程图状态。 */
export function evaluationEvents(id: string) { return request<EvaluationEvent[]>(`${endpoint}?id=${encodeURIComponent(id)}&events=true`); }
/** 取消正在运行的评估。 */
export function cancelEvaluation(id: string) { return request<{ cancelled: boolean }>(endpoint, { action: "cancel", id }); }
/** 只刷新已有证据的同步与评分。 */
export function refreshEvaluationScores(id: string) { return request<EvaluationRun>(endpoint, { action: "refresh_scores", id }); }
