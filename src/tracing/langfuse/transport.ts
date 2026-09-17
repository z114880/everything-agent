import type { LangfuseConfiguration } from "./configuration.ts";

/** 有界、顺序发送，失败留在状态中；不把服务端错误正文或凭证写入日志。 */
export class LangfuseTransport {
  private pending = 0;
  private unavailableUntil = 0;
  private tail = Promise.resolve();
  private errors: string[] = [];
  private readonly config: LangfuseConfiguration;
  constructor(config: LangfuseConfiguration, privateWarning: (message: string) => void = () => {}) {
    this.config = config;
    this.warning = privateWarning;
  }
  private readonly warning: (message: string) => void;
  enqueue(path: string, body: unknown): void {
    if (this.pending >= 256) { this.fail("Langfuse 导出队列已满，部分记录未上传"); return; }
    // 入队时固定数据，后续状态变更不影响已完成操作的证据。
    const data = JSON.stringify(body);
    this.pending++;
    this.tail = this.tail.then(async () => {
      try {
        if (Date.now() < this.unavailableUntil) { this.fail("Langfuse 暂时不可用，部分记录未上传"); return; }
        const response = await fetch(`${this.config.baseUrl}${path}`, {
          method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
          headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`${this.config.publicKey}:${this.config.secretKey}`).toString("base64")}`, "x-langfuse-ingestion-version": "4" }, body: data,
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
        const text = await response.text();
        if (text) {
          const result = JSON.parse(text) as { partialSuccess?: { rejectedSpans?: string | number; errorMessage?: string } };
          if (Number(result.partialSuccess?.rejectedSpans ?? 0) > 0 || result.partialSuccess?.errorMessage) throw new Error("部分记录被拒绝");
        }
      } catch (error) {
        this.unavailableUntil = Date.now() + 5000;
        const detail = error instanceof Error && /^HTTP \d+$/.test(error.message) ? error.message : "请求失败或部分记录被拒绝";
        this.fail(`Langfuse 导出失败：${detail}`);
      } finally { this.pending--; }
    });
  }
  async flush(): Promise<string[]> { await this.tail; return [...this.errors]; }
  private fail(message: string): void {
    if (!this.errors.includes(message) && this.errors.length < 10) {
      this.errors.push(message); this.warning(message);
    }
  }
}
