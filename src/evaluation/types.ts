/** 一条平台数据集用例；input 支持字符串、{ prompt } 或 { turns: string[] }。 */
export interface EvaluationCase { id: string; input: unknown; expectedOutput?: unknown; terminalEnabled?: boolean; }
/** 一次评估启动参数；只接受固定选项，不接受远程路径或凭证覆盖。 */
export interface EvaluationInput { datasetName: string; datasetId?: string; name?: string; }
/** 平台评分原值；没有配置质量阈值时不推断通过。 */
export interface EvaluationScore { id: string; name: string; value: unknown; comment?: string; }
/** 来自真实 Runtime 的有序、脱敏执行记录。 */
export interface EvaluationEvent { sequence: number; kind: string; timestamp: string; data: Record<string, unknown>; }
/** 每条用例的执行、同步和评分分别记录。 */
export interface EvaluationItem extends EvaluationCase {
  traceId: string; observationId: string;
  status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
  output: string[]; events: EvaluationEvent[]; scores: EvaluationScore[];
  sync: 'pending' | 'synced' | 'failed'; error?: string; syncError?: string;
  startedAt?: string; finishedAt?: string; ms?: number; model?: string;
  toolCalls: number; inputTokens: number | null; outputTokens: number | null;
  approvalDenied: boolean;
}
/** 可持久化的评估运行摘要及用例详情。 */
export interface EvaluationRun {
  id: string; name: string; datasetName: string; datasetId: string; datasetVersion: string;
  memorySnapshot: boolean; createdAt: string; finishedAt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  items: EvaluationItem[]; error?: string; scoreError?: string;
}
/** 本地集成配置；密钥只存在于服务端。 */
export interface LangfuseConfiguration { baseUrl: string; publicKey: string; secretKey: string; projectId: string; }
