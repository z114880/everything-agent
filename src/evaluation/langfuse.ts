import { LangfuseClient } from '@langfuse/client';
import { createHash } from 'node:crypto';
import type { EvaluationCase, EvaluationItem, EvaluationRun, EvaluationScore, LangfuseConfiguration } from './types.ts';

/** Langfuse v4 接入：SDK 固定数据集版本，OTLP 回传真实运行，显式检查部分接收失败。 */
export class LangfuseEvaluationClient {
  readonly configuration: LangfuseConfiguration;
  private readonly sdk: LangfuseClient;
  constructor(configuration: LangfuseConfiguration) {
    this.configuration = configuration;
    this.sdk = new LangfuseClient({ ...configuration, timeout: 20 });
  }
  /** 获取平台数据集目录。 */
  async datasets(): Promise<{ id: string; name: string }[]> {
    const items: { id: string; name: string }[] = [];
    for (let page = 1; ; page++) {
      const result = await this.request<{ data: { id: string; name: string }[]; meta: { totalPages: number } }>(`/api/public/v2/datasets?page=${page}&limit=100`);
      items.push(...result.data.map(item => ({ id: item.id, name: item.name })));
      if (page >= result.meta.totalPages) return items;
    }
  }
  /** 数据集按时间点读取；归档项不参与运行。 */
  async dataset(name: string, version: string): Promise<{ id: string; items: EvaluationCase[] }> {
    const data = await this.sdk.dataset.get(name, { version });
    return { id: data.id, items: data.items.filter(item => item.status === 'ACTIVE').map(item => ({ id: item.id, input: item.input, expectedOutput: item.expectedOutput, terminalEnabled: Boolean(item.metadata && typeof item.metadata === 'object' && 'terminal' in item.metadata && item.metadata.terminal === true) })) };
  }
  /** 按用例根 observation 拉取平台评分，完整消费游标。 */
  async scores(item: EvaluationItem): Promise<EvaluationScore[]> {
    const scores: EvaluationScore[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ traceId: item.traceId, observationId: item.observationId, fields: 'details', limit: '100' });
      if (cursor) query.set('cursor', cursor);
      const page = await this.request<{ data: EvaluationScore[]; meta: { cursor?: string } }>(`/api/public/v3/scores?${query}`);
      scores.push(...page.data.map(score => ({ id: score.id, name: score.name, value: score.value, ...(score.comment ? { comment: score.comment } : {}) })));
      cursor = page.meta.cursor;
      if (cursor && seen.has(cursor)) throw new Error('Langfuse 评分分页游标重复');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return scores;
  }
  /** 回传单条用例；同一组 trace/span ID 可重试，不重新执行真实工具。 */
  async publish(run: EvaluationRun, item: EvaluationItem): Promise<void> {
    const shared = {
      'langfuse.environment': 'evaluation',
      'langfuse.experiment.id': run.id,
      'langfuse.experiment.name': run.name,
      'langfuse.experiment.dataset.id': run.datasetId,
      'langfuse.experiment.item.id': item.id,
      'langfuse.experiment.item.version': run.datasetVersion,
      'langfuse.experiment.item.root_observation_id': item.observationId,
      'langfuse.experiment.metadata.memory_snapshot': String(run.memorySnapshot),
    };
    const root = span(item.traceId, item.observationId, undefined, 'Everything Agent', item.startedAt!, item.finishedAt!, {
      ...shared, 'langfuse.observation.type': 'agent',
      'langfuse.observation.input': JSON.stringify(item.input),
      'langfuse.observation.output': JSON.stringify(item.output.length === 1 ? item.output[0] : item.output),
      'langfuse.experiment.item.expected_output': JSON.stringify(item.expectedOutput ?? null),
      'langfuse.observation.metadata.execution_status': item.status,
      ...(item.error ? { 'langfuse.observation.status_message': item.error, 'langfuse.observation.level': 'ERROR' } : {}),
    }, item.status !== 'completed');
    const children = item.events.filter(event => ['model_response', 'model_failed', 'tool_completed', 'tool_failed'].includes(event.kind)).map(event => {
      const data = event.data;
      const isModel = event.kind.startsWith('model_');
      const start = item.events.find(candidate => candidate.kind === (isModel ? 'model_request' : 'tool_started') && candidate.data[isModel ? 'modelCallId' : 'toolCallId'] === data[isModel ? 'modelCallId' : 'toolCallId']);
      return span(item.traceId, createHash('sha256').update(`${item.traceId}:${event.sequence}`).digest('hex').slice(0, 16), item.observationId,
        isModel ? String(item.model ?? '模型调用') : String(data.tool ?? '工具调用'), start?.timestamp ?? event.timestamp, event.timestamp,
        { ...shared, 'langfuse.observation.type': isModel ? 'generation' : 'tool',
          'langfuse.observation.metadata.event': JSON.stringify(data),
          ...(isModel ? { 'langfuse.observation.model.name': item.model ?? '',
            ...(data.tokenUsage ? { 'langfuse.observation.usage_details': JSON.stringify(toUsage(data.tokenUsage)) } : {}) } : {}),
        }, event.kind.endsWith('failed') || data.isError === true);
    });
    const response = await this.request<{ partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } }>('/api/public/otel/v1/traces', {
      resourceSpans: [{ resource: { attributes: attributes({ 'service.name': 'everything-agent-evaluation' }) }, scopeSpans: [{ scope: { name: 'everything-agent' }, spans: [root, ...children] }] }],
    });
    if (Number(response.partialSuccess?.rejectedSpans ?? 0) > 0 || response.partialSuccess?.errorMessage) throw new Error('Langfuse 未完整接收执行轨迹');
  }
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.configuration.baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Basic ${Buffer.from(`${this.configuration.publicKey}:${this.configuration.secretKey}`).toString('base64')}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Langfuse 请求失败（HTTP ${response.status}）`);
    return await response.json() as T;
  }
}
function attributes(values: Record<string, string | undefined>) { return Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => ({ key, value: { stringValue: value } })); }
function span(traceId: string, spanId: string, parentSpanId: string | undefined, name: string, start: string, end: string, values: Record<string, string | undefined>, failed: boolean) {
  return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind: 1,
    startTimeUnixNano: String(BigInt(Date.parse(start)) * 1_000_000n), endTimeUnixNano: String(BigInt(Date.parse(end)) * 1_000_000n),
    attributes: attributes(values), status: { code: failed ? 2 : 1 } };
}
function toUsage(value: unknown) {
  const usage = value as Record<string, unknown>;
  return { input: usage.inputTokens, output: usage.outputTokens };
}
