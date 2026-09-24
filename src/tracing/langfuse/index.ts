import type { TraceRecord } from "../jsonl-tracer.ts";
import type { LangfuseConfiguration } from "./configuration.ts";
import { LangfuseTransport } from "./transport.ts";
import { identifier, ObservationMapper, otlpBody, type Observation } from "./observations.ts";
export { readLangfuseConfiguration } from "./configuration.ts";
export type { LangfuseConfiguration } from "./configuration.ts";

/** 从运行事件导出到 Langfuse v4；网络故障不打断回合，flush 返回导出错误。 */
export function createLangfuseTracer(config: LangfuseConfiguration, onWarning: (message: string) => void = () => {}) {
  const transport = new LangfuseTransport(config, onWarning);
  const mapper = new ObservationMapper((record) => ({ traceId: identifier(record.traceId), attributes: { "langfuse.environment": "local", "langfuse.trace.name": "个人助理", "langfuse.trace.metadata.traceId": record.traceId, ...(record.turnId ? { "langfuse.trace.metadata.turnId": record.turnId } : {}), ...(record.taskId ? { "langfuse.trace.metadata.taskId": record.taskId } : {}) } }), config.captureContent, onWarning);
  let buffer: Observation[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function send() {
    if (timer) clearTimeout(timer); timer = undefined;
    while (buffer.length) transport.enqueue("/api/public/otel/v1/traces", otlpBody(buffer.splice(0, 64)));
  }
  return {
    record(record: TraceRecord): void {
      const span = mapper.accept(record);
      if (span) buffer.push(span);
      if (buffer.length >= 64 || ["turn_completed", "turn_failed", "memory_task_completed", "consolidation_completed"].includes(record.type)) send();
      else if (!timer) { timer = setTimeout(send, 1000); timer.unref(); }
    },
    /** 普通刷新不结束仍在运行的步骤；关闭时将未完成步骤明确标错。 */
    async flush(close = false) {
      if (close) buffer.push(...mapper.finish());
      send(); return transport.flush();
    },
  };
}
