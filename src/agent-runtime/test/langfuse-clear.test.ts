import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createAgentRuntime } from "../index.ts";
import { JsonlTracer } from "../../tracing/jsonl-tracer.ts";

const homes: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });

it.each([true, false])("清理数据同步删除对应远端 traces，成功=%s", async (success) => {
  vi.stubEnv("LANGFUSE_ENABLED", "true");
  vi.stubEnv("LANGFUSE_BASE_URL", "http://langfuse.invalid");
  vi.stubEnv("LANGFUSE_PUBLIC_KEY", "p");
  vi.stubEnv("LANGFUSE_SECRET_KEY", "s");
  const home = await mkdtemp(join(tmpdir(), "clear-langfuse-")); homes.push(home);
  const tracer = new JsonlTracer(home);
  await tracer.record("run_started", { runId: "clear-test" });
  await tracer.flush();
  const runtime = createAgentRuntime({ home, defaultSystemPromptPath: join(home, "EVERYTHING.md") });
  const records = (await runtime.readTraces()).flatMap(file => file.records);
  const fetchMock = vi.fn(async () => new Response("{}", { status: success ? 200 : 503 }));
  vi.stubGlobal("fetch", fetchMock);
  try {
    if (success) {
      await expect(runtime.clearLocalAgentData()).resolves.toEqual({ cleared: true });
      expect(await runtime.readTraces()).toEqual([]);
    } else {
      await expect(runtime.clearLocalAgentData()).rejects.toThrow("Langfuse");
      expect(await runtime.readTraces()).not.toEqual([]);
    }
    expect(fetchMock).toHaveBeenCalledWith("http://langfuse.invalid/api/public/traces", expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ traceIds: [...new Set(records.map(record => createHash("sha256").update(record.runId).digest("hex").slice(0, 32)))] }),
    }));
  } finally { await runtime.close(); }
});
