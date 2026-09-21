import { JsonlTracer } from "./jsonl-tracer.ts";
import { createTraceEventFactory } from "./trace-event.ts";
import { createLangfuseTracer, readLangfuseConfiguration } from "./langfuse/index.ts";

/** 实时事件分流：本地写入和 OTLP 导出共享脱敏事件，网络发送不阻塞运行。 */
export function createRuntimeTracer(home: string, exportEnabled = true) {
  const createEvent = createTraceEventFactory();
  const jsonl = new JsonlTracer(home);
  const warn = (message: string) => {
    // 导出错误只写本地，避免重新进入 exporter 形成递归。
    void jsonl.writeEvent(createEvent("langfuse_export_failed", { message }));
  };
  let exporter: ReturnType<typeof createLangfuseTracer> | undefined;
  try {
    const configuration = exportEnabled ? readLangfuseConfiguration(home) : null;
    if (configuration) exporter = createLangfuseTracer(configuration, warn);
  } catch {
    warn("Langfuse 配置无效，本次 Runtime 仅记录本地事件，请检查服务端配置");
  }
  return {
    async record(type: string, fields: Record<string, unknown>): Promise<void> {
      const event = createEvent(type, fields);
      const writing = jsonl.writeEvent(event);
      try { exporter?.record(event); }
      catch { warn("Langfuse 事件转换失败，事件仍保存在本地"); }
      await writing;
    },
    /** 停止生产事件后调用；先结束导出，再等待本地记录（包含导出错误）落盘。 */
    async close(): Promise<void> {
      await exporter?.flush(true);
      await jsonl.flush();
    },
  };
}
