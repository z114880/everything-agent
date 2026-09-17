import { readLangfuseConfiguration, type LangfuseConfiguration } from "../tracing/langfuse/index.ts";
import { identifier as traceIdentifier, makeObservation, ObservationMapper, otlpBody } from "../tracing/langfuse/observations.ts";
import { validateDataset } from "./validation.ts";
import type { DatasetReference, DatasetSnapshot, EvaluationCase, EvaluationDataset, EvaluationExecution, EvaluationRun, EvaluationScore } from "./types.ts";

/** Langfuse v4 API。所有请求留在服务端，错误信息不回显响应正文或凭证。 */
export class EvaluationLangfuse {
  private readonly config: LangfuseConfiguration;
  constructor(home: string) {
    const config = readLangfuseConfiguration(home);
    if (!config) throw new Error("请先配置并启用 Langfuse");
    this.config = config;
  }
  /** 浏览器只获得连接状态与项目链接。 */
  static status(home: string) {
    const config = readLangfuseConfiguration(home);
    return { configured: config !== null, captureContent: config?.evaluationCaptureContent ?? false, url: config ? projectUrl(config) : null };
  }
  private async request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.config.baseUrl}/api/public${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64")}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    }).catch(() => { throw new Error("Langfuse 请求失败或超时"); });
    if (!response.ok) throw new Error(`Langfuse API 请求失败（${response.status}）`);
    try { return await response.json() as T; } catch { throw new Error("Langfuse API 响应不是有效 JSON"); }
  }
  /** 每次保存创建不可变版本；全部上传成功后由服务提交本地版本引用。 */
  async saveDataset(value: unknown): Promise<DatasetReference> {
    const dataset = validateDataset(value);
    const remoteName = `everything/${dataset.id}/${crypto.randomUUID()}`;
    const remote = await this.request<{ id: string }>("/v2/datasets", { name: remoteName, description: dataset.description, metadata: { application: "everything-agent", datasetId: dataset.id, displayName: dataset.name } });
    let version = "";
    for (const testCase of dataset.cases) {
      const item = await this.request<{ updatedAt: string }>("/dataset-items", { id: traceIdentifier(`${remoteName}:${testCase.id}`), datasetName: remoteName, input: testCase, expectedOutput: testCase.expectedOutput, metadata: { criteria: testCase.criteria, scoreName: testCase.judge?.scoreName ?? null }, status: "ACTIVE" });
      if (!Number.isFinite(Date.parse(item.updatedAt))) throw new Error("Langfuse 未返回有效的数据集版本时间");
      if (item.updatedAt > version) version = item.updatedAt;
    }
    return { id: dataset.id, name: dataset.name, description: dataset.description, defaultEnabled: dataset.defaultEnabled, remoteName, remoteId: remote.id, version, count: dataset.cases.length, url: this.config.projectId ? `${projectUrl(this.config)}/datasets/${encodeURIComponent(remote.id)}` : null };
  }
  /** 固定版本分页读取，避免多页查询期间的数据编辑改变运行输入。 */
  async dataset(reference: DatasetReference): Promise<DatasetSnapshot> {
    const cases: EvaluationCase[] = []; const itemIds: Record<string, string> = {};
    for (let page = 1; page <= 100; page++) {
      const query = new URLSearchParams({ datasetName: reference.remoteName, version: reference.version, page: String(page), limit: "100" });
      const result = await this.request<{ data: { id: string; input: EvaluationCase; status: string }[]; meta: { totalPages: number } }>(`/dataset-items?${query}`);
      if (!Array.isArray(result.data) || !Number.isInteger(result.meta?.totalPages)) throw new Error("Langfuse 数据集响应无效");
      for (const item of result.data) if (item.status === "ACTIVE") { cases.push(item.input); itemIds[item.input.id] = item.id; }
      if (page >= result.meta.totalPages) break;
      if (page === 100) throw new Error("Langfuse 数据集分页超过限制");
    }
    const validated = validateDataset({ ...reference, cases });
    if (cases.length !== reference.count) throw new Error("Langfuse 数据集版本不完整，请重新保存数据集");
    return { ...reference, cases: validated.cases, itemIds };
  }
  /** 先上传子步骤，最后提交 experiment item 根节点，让裁判读取完整证据。 */
  async publish(run: EvaluationRun, execution: EvaluationExecution, signal?: AbortSignal): Promise<void> {
    const dataset = run.datasets.find(d => d.id === execution.datasetId)!;
    const testCase = dataset.cases.find(c => c.id === execution.caseId)!;
    if (testCase.judge && !this.config.evaluationCaptureContent) throw new Error("语义评分需要启用 LANGFUSE_EVALUATION_CAPTURE_CONTENT，仅上传脱敏测试数据");
    const traceId = execution.traceId, rootId = execution.observationId;
    const attributes = { "langfuse.environment": "evaluation", "langfuse.experiment.id": `${run.id}-${dataset.id}`, "langfuse.experiment.name": `${dataset.name} / ${run.createdAt}`, "langfuse.experiment.dataset.id": dataset.remoteId, "langfuse.experiment.item.version": dataset.version, "langfuse.experiment.item.id": dataset.itemIds[testCase.id], "langfuse.experiment.item.root_observation_id": rootId, "langfuse.experiment.metadata.codeHash": run.codeHash };
    const mapper = new ObservationMapper(() => ({ traceId, rootId, attributes }), this.config.evaluationCaptureContent);
    const records = (execution.evidence?.traces.flatMap(f => f.records) ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || (a.sequence ?? 0) - (b.sequence ?? 0));
    const spans = records.flatMap(record => { const span = mapper.accept(record); return span ? [span] : []; });
    spans.push(...mapper.finish());
    spans.push(makeObservation(traceId, rootId, testCase.name, "agent", records[0]?.timestamp ?? run.createdAt, records.at(-1)?.timestamp ?? new Date().toISOString(), {
      ...attributes,
      "langfuse.observation.input": this.config.evaluationCaptureContent ? { turns: testCase.turns, criteria: testCase.criteria, expectedOutput: testCase.expectedOutput } : { caseId: testCase.id },
      "langfuse.observation.output": this.config.evaluationCaptureContent ? { replies: execution.evidence?.replies, tools: execution.evidence?.toolCalls, memory: execution.evidence?.memory, files: execution.evidence?.files, complete: execution.evidence?.complete } : { status: execution.status },
      "langfuse.experiment.item.expected_output": this.config.evaluationCaptureContent ? testCase.expectedOutput : undefined,
      "langfuse.experiment.item.metadata.criteria": this.config.evaluationCaptureContent ? testCase.criteria : undefined,
    }, undefined, execution.status !== "completed"));
    for (let index = 0; index < spans.length; index += 64) {
      const result = await this.request<{ partialSuccess?: { rejectedSpans?: number | string; errorMessage?: string } }>("/otel/v1/traces", otlpBody(spans.slice(index, index + 64)), signal);
      if (Number(result.partialSuccess?.rejectedSpans ?? 0) > 0 || result.partialSuccess?.errorMessage) throw new Error("Langfuse 拒收了部分执行轨迹");
    }
    for (const score of execution.scores.filter(score => score.name.includes(":"))) await this.request("/scores", { id: traceIdentifier(`${traceId}:${score.name}`), traceId, observationId: rootId, name: score.name, dataType: "NUMERIC", value: score.score, comment: score.reason, environment: "evaluation" }, signal);
    execution.traceUrl = this.config.projectId ? `${projectUrl(this.config)}/traces/${traceId}` : null;
    execution.sync = "synced";
  }
  /** 只接受绑定到该根 observation 的平台自动裁判，人工/API 同名分数不能冒充。 */
  async score(execution: EvaluationExecution, testCase: EvaluationCase, signal?: AbortSignal): Promise<EvaluationScore | null> {
    if (!testCase.judge) return null;
    const matches: { name: string; value: unknown; dataType: string; comment?: string; updatedAt: string; source: string; subject?: { kind: string; id: string; traceId?: string } }[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const query = new URLSearchParams({ traceId: execution.traceId, observationId: execution.observationId, name: testCase.judge.scoreName, source: "EVAL", fields: "details,subject", limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const result = await this.request<{ data: typeof matches; meta: { cursor?: string } }>(`/v3/scores?${query}`, undefined, signal);
      if (!Array.isArray(result.data)) throw new Error("Langfuse 评分响应无效");
      matches.push(...result.data.filter(s => s.source === "EVAL" && s.name === testCase.judge!.scoreName && s.subject?.kind === "observation" && s.subject.id === execution.observationId && s.subject.traceId === execution.traceId));
      cursor = result.meta?.cursor;
      if (cursor && (seen.has(cursor) || seen.size >= 100)) throw new Error("Langfuse 评分分页无效");
      if (cursor) seen.add(cursor);
    } while (cursor);
    const latest = matches.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (!latest) return null;
    if (latest.dataType !== "NUMERIC" || typeof latest.value !== "number" || !Number.isFinite(latest.value) || latest.value < 0 || latest.value > 1) return { name: testCase.judge.scoreName, status: "error", score: null, reason: "Langfuse 裁判必须返回 0–1 数值" };
    return { name: testCase.judge.scoreName, status: latest.value >= testCase.judge.threshold ? "passed" : "failed", score: latest.value, reason: latest.comment || "Langfuse 自动裁判" };
  }
}
function projectUrl(config: LangfuseConfiguration): string { return config.projectId ? `${config.baseUrl}/project/${encodeURIComponent(config.projectId)}` : config.baseUrl; }
