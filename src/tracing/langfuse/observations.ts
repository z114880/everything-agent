import { createHash } from "node:crypto";
import type { TraceRecord } from "../jsonl-tracer.ts";

export interface Observation {
  traceId: string; spanId: string; parentSpanId?: string;
  name: string; kind: number; startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue: string } }[];
  status: { code: number };
}
export interface ObservationContext { traceId: string; rootId?: string; attributes?: Record<string, unknown> }
export function identifier(value: string, length = 32): string { return createHash("sha256").update(value).digest("hex").slice(0, length); }

// 只保留明确的标识、枚举和统计字段；查询、理由、路径和正文需要另行选择上传。
const metadataKeys = new Set("eventId sequence rebuildId result semantic sessionRecall sessions hits session id tool runId sessionId iteration modelCallId toolCallId operationId parentOperationId sourceRunId taskId taskKind attempt batchIndex candidateId action intent reasonCode targetId deletedIds evidenceMessageIds candidateIds revision completedBatches totalBatches factCount decisionCount unresolvedConflicts semanticCount sessionCount mode corpus candidateCount selected excludedAsDuplicate skill contentHash instructionLength count model provider ms durationMs tokenUsage inputTokens outputTokens totalTokens stopReason isError errorType returnedSessionCount returnedMessageCount returnedRanges isComplete truncated requestedLimit droppedSessionCount retrievalMode outputLength estimatedTokens itemCount dimensions purpose rank match retrievalSignals sessionRecallSessionIds semanticMemoryIds sessionRecallRanges sessionRecallEstimatedTokens sessionRecallTruncated approved networkAllowed exitCode timedOut".split(" "));
const containerKeys = new Set(["result", "semantic", "sessionRecall", "sessions", "hits", "session", "selected", "match", "retrievalSignals", "tokenUsage"]);
export function safeMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeMetadata);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => metadataKeys.has(key)).flatMap(([key, item]) => {
    if (containerKeys.has(key)) {
      if (!item || typeof item !== "object") return [];
      if (Array.isArray(item)) return [[key, item.filter((entry) => entry && typeof entry === "object").map(safeMetadata)]];
    }
    return [[key, safeMetadata(item)]];
  }));
}
const lifecycle: Record<string, [string, string, "start" | "end"]> = {
  embedding_rebuild_started: ["span", "rebuild", "start"], embedding_rebuild_completed: ["span", "rebuild", "end"], embedding_rebuild_failed: ["span", "rebuild", "end"], embedding_rebuild_cancelled: ["span", "rebuild", "end"],
  run_started: ["agent", "run", "start"], run_completed: ["agent", "run", "end"], run_failed: ["agent", "run", "end"],
  model_request: ["generation", "model", "start"], model_response: ["generation", "model", "end"], model_failed: ["generation", "model", "end"],
  tool_started: ["tool", "tool", "start"], tool_completed: ["tool", "tool", "end"], tool_failed: ["tool", "tool", "end"],
  gate_start: ["generation", "gate", "start"], gate_end: ["generation", "gate", "end"],
  retrieval_start: ["retriever", "retrieval", "start"], retrieval_completed: ["retriever", "retrieval", "end"],
  embedding_started: ["embedding", "embedding", "start"], embedding_completed: ["embedding", "embedding", "end"], embedding_failed: ["embedding", "embedding", "end"],
  memory_model_started: ["generation", "memory_model", "start"], memory_model_completed: ["generation", "memory_model", "end"], memory_model_failed: ["generation", "memory_model", "end"],
  consolidation_model_started: ["generation", "consolidation_model", "start"], consolidation_model_completed: ["generation", "consolidation_model", "end"], consolidation_model_failed: ["generation", "consolidation_model", "end"],
  memory_task_started: ["span", "task", "start"], memory_task_completed: ["span", "task", "end"], memory_task_retry: ["span", "task", "end"], memory_task_failed: ["span", "task", "end"],
  consolidation_started: ["span", "consolidation", "start"], consolidation_completed: ["span", "consolidation", "end"], consolidation_retry: ["span", "consolidation", "end"], consolidation_failed: ["span", "consolidation", "end"],
  consolidation_batch_started: ["span", "batch", "start"], consolidation_batch_completed: ["span", "batch", "end"], consolidation_batch_failed: ["span", "batch", "end"],
};

/** 按实际开始/结束事件建立 observation；没有开始事件时仅记录瞬时事件。 */
export class ObservationMapper {
  private starts = new Map<string, TraceRecord>();
  private roots = new Map<string, string>();
  constructor(privateContext: (record: TraceRecord) => ObservationContext, captureContent = false, onWarning: (message: string) => void = () => {}) { this.context = privateContext; this.captureContent = captureContent; this.onWarning = onWarning; }
  private readonly onWarning: (message: string) => void;
  private readonly context: (record: TraceRecord) => ObservationContext;
  private readonly captureContent: boolean;
  accept(record: TraceRecord): Observation | null {
    const spec = lifecycle[record.type];
    const key = this.key(record, spec?.[1] ?? record.type);
    if (spec?.[2] === "start") {
      // 不允许失联任务无限占用内存；丢失开始事件后只产生瞬时事件。
      if (this.starts.size >= 4096) { this.starts.delete(this.starts.keys().next().value!); this.onWarning("Langfuse 活跃步骤超过上限，部分步骤无法完整关联"); }
      this.starts.set(key, record);
      if (["run", "task", "consolidation", "rebuild"].includes(spec[1])) {
        if (this.roots.size >= 4096) this.roots.delete(this.roots.keys().next().value!);
        this.roots.set(record.runId, this.spanId(record, key));
      }
      return null;
    }
    const start = this.starts.get(key);
    this.starts.delete(key);
    return this.convert(start ?? record, record, start ? spec![0] : "event", start ? spec![1] : record.type, key);
  }
  finish(): Observation[] {
    const pending = [...this.starts]; this.starts.clear();
    return pending.map(([key, start]) => this.convert(start, { ...start, type: "observation_incomplete" }, lifecycle[start.type]![0], lifecycle[start.type]![1], key));
  }
  private spanId(record: TraceRecord, key: string): string {
    return identifier(`${key}:${record.eventId ?? record.sequence ?? record.timestamp}`, 16);
  }
  private key(r: TraceRecord, family: string): string {
    const callId = ["run", "task", "consolidation", "rebuild"].includes(family) ? ""
      : family === "tool" ? r.toolCallId ?? ""
      : family === "batch" ? r.payload?.batchIndex ?? "" : r.modelCallId ?? r.operationId ?? "";
    return `${r.runId}:${family}:${callId}:${r.payload?.attempt ?? ""}`;
  }
  private convert(start: TraceRecord, end: TraceRecord, type: string, family: string, key: string): Observation {
    const context = this.context(end);
    const root = ["run", "task", "consolidation", "rebuild"].includes(family);
    const runRootId = this.roots.get(end.runId);
    const spanId = this.spanId(start, key);
    const toolKey = this.key(end, "tool");
    const toolStart = this.starts.get(toolKey);
    const batchKey = this.key(end, "batch");
    const batchStart = this.starts.get(batchKey);
    const parent = root ? context.rootId
      : toolStart && family !== "tool" ? this.spanId(toolStart, toolKey)
      : batchStart && family !== "batch" ? this.spanId(batchStart, batchKey) : runRootId ?? context.rootId;
    const payload = { ...start.payload, ...end.payload };
    const attributes: Record<string, unknown> = {
      ...context.attributes, "langfuse.session.id": end.sessionId,
      "langfuse.observation.type": type,
      "langfuse.observation.metadata.event": end.type,
      "langfuse.observation.metadata.execution": safeMetadata({ ...end, ...payload }),
      "langfuse.observation.model.name": payload.model,
    };
    const usage = payload.tokenUsage as { inputTokens?: number; outputTokens?: number } | undefined;
    if (usage) attributes["langfuse.observation.usage_details"] = { input: usage.inputTokens, output: usage.outputTokens };
    if (this.captureContent) {
      attributes["langfuse.observation.input"] = start.payload?.request ?? start.payload?.userInput ?? payload.arguments;
      attributes["langfuse.observation.output"] = payload.response ?? payload.reply ?? payload.result;
    }
    const error = end.type.endsWith("failed") || end.type.endsWith("retry") || end.type === "observation_incomplete" || end.type.endsWith("cancelled") || payload.isError === true || Boolean(payload.errorType);
    attributes["langfuse.observation.level"] = error ? "ERROR" : "DEFAULT";
    return makeObservation(context.traceId, spanId, root ? family : typeof payload.tool === "string" ? payload.tool : family, type, start.timestamp, end.timestamp, attributes, parent, error);
  }
}
export function makeObservation(traceId: string, spanId: string, name: string, type: string, start: string, end: string, attributes: Record<string, unknown>, parentSpanId?: string, error = false): Observation {
  return { traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}), name, kind: 1,
    startTimeUnixNano: String(BigInt(Date.parse(start)) * 1000000n), endTimeUnixNano: String(BigInt(Math.max(Date.parse(start), Date.parse(end))) * 1000000n),
    attributes: Object.entries({ ...attributes, "langfuse.observation.type": type }).filter(([, value]) => value !== undefined).map(([key, value]) => ({ key, value: { stringValue: typeof value === "string" ? value : JSON.stringify(value) } })), status: { code: error ? 2 : 1 },
  };
}
export function otlpBody(spans: Observation[]) { return { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "everything-agent" } }] }, scopeSpans: [{ scope: { name: "everything-agent.langfuse", version: "1" }, spans }] }] }; }
