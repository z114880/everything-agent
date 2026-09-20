import type { EvaluationRun } from '../../src/evaluation/types';
export interface EvaluationDashboard {
  configured: boolean; error: string; baseUrl: string; projectId: string; webhookUrl: string; runs: EvaluationRun[];
  approvals: { id: string; runId: string; itemId: string; command: string; reason: string; detail?: string }[];
}
/** 读取本地评估快照；网络失败保留给界面展示。 */
export async function evaluationRequest<T>(path = '', body?: unknown): Promise<T> {
  const response = await fetch(`/api/evaluation${path}`, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '评估请求失败');
  return result as T;
}
