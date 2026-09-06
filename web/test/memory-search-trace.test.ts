import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRuntime } from "../../src/memory/index.ts";
import { JsonlTracer, readTraceRecords } from "../../src/tracing/jsonl-tracer.ts";

const state = vi.hoisted(() => ({ memory: null as MemoryRuntime | null }));
vi.mock("../../src/index.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/index.ts")>(),
  createAgentRuntime: () => ({
    get memory() { return state.memory! },
    prepareMemory: async () => ({ searchWindow: 5, scrollStep: 10, messageLimit: 100, tokenLimit: 50_000,
      tokenEstimator: { estimateText: (text: string) => text.length } }),
  }),
}));
import { handleMemoryAction } from "../server/agent-service.ts";

let home: string;
afterEach(async () => {
  state.memory?.close();
  state.memory = null;
  if (home) await rm(home, { recursive: true, force: true });
});

it("Memory 页面手动搜索返回结果但不写 trace，默认检索仍记录事件", async () => {
  home = await mkdtemp(join(tmpdir(), "memory-page-trace-"));
  const memory = state.memory = new MemoryRuntime(home);
  const tracer = new JsonlTracer(home);
  memory.configureRetrieval({ mode: "lexical_only", observer: (kind, event) => tracer.record(kind, event) });
  const fact = await memory.createSemantic("饮品", "喜欢咖啡");

  expect(await handleMemoryAction({ action: "search_semantic", query: "咖啡" }))
    .toEqual([expect.objectContaining({ id: fact.id })]);
  await handleMemoryAction({ action: "session_search", query: "咖啡" });
  await tracer.flush();
  expect(await readTraceRecords(home)).toEqual([]);

  await memory.searchSemantic("咖啡");
  await tracer.flush();
  expect(await readTraceRecords(home)).toEqual([
    expect.objectContaining({ type: "lexical_retrieval_completed" }),
  ]);
});
