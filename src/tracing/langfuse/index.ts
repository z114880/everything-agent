import type { TraceRecord } from "../jsonl-tracer.ts";
import type { LangfuseConfiguration } from "./configuration.ts";
import { LangfuseTransport } from "./transport.ts";
import { identifier, ObservationMapper, otlpBody, type Observation } from "./observations.ts";
export { readLangfuseConfiguration } from "./configuration.ts";
export type { LangfuseConfiguration } from "./configuration.ts";

/** 从运行事件导出到 Langfuse v4；网络故障不打断回合，flush 返回导出错误。 */
export function createLangfuseTracer(config: LangfuseConfiguration, onWarning: (message: string) => void = () => {}) {
  const transport = new LangfuseTransport(config, onWarning);
  const mapper = new ObservationMapper((record) => ({ traceId: identifier(record.runId), attributes: { "langfuse.environment": "local", "langfuse.trace.name": "个人助理", "langfuse.trace.metadata.runId": record.runId } }), config.captureContent);
  let buffer: Observation[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  function send() {
    if (timer) clearTimeout(timer); timer = undefined;
    if (buffer.length) { transport.enqueue("/api/public/otel/v1/traces", otlpBody(buffer)); buffer = []; }
  }
  return {
    record(record: TraceRecord): void {
      const span = mapper.accept(record);
      if (span) buffer.push(span);
      if (buffer.length >= 64 || ["run_completed", "run_failed", "memory_task_completed", "consolidation_completed"].includes(record.type)) send();
      else if (!timer) { timer = setTimeout(send, 1000); timer.unref(); }
    },
    /** 普通刷新不结束仍在运行的步骤；关闭时将未完成步骤明确标错。 */
    async flush(close = false) {
      if (close) buffer.push(...mapper.finish());
      send(); return transport.flush();
    },
  };
}

/** 删除本地运行对应的远端 traces；远端只确认受理，实际删除可能延迟。失败抛错以保留本地重试依据。 */
export async function deleteLangfuseRunTraces(config: LangfuseConfiguration, runIds: string[]): Promise<void> {
  const traceIds = [...new Set(runIds.map(runId => identifier(runId)))];
  for (let offset = 0; offset < traceIds.length; offset += 50) {
    try {
      const response = await fetch(`${config.baseUrl}/api/public/traces`, {
        method: "DELETE", redirect: "error", signal: AbortSignal.timeout(10000),
        headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${config.publicKey}:${config.secretKey}`).toString("base64")}` },
        body: JSON.stringify({ traceIds: traceIds.slice(offset, offset + 50) }),
      });
      await response.body?.cancel();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      const detail = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : "请求失败";
      throw new Error(`Langfuse trace 删除失败：${detail}；本地数据已保留，请重试`);
    }
  }
}
