import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlTracer, readTraceFiles, readTraceRecords } from "../jsonl-tracer.ts";

describe("JSONL 运行记录", () => {
  it("写入可用于 eval 的完整模型请求与结构化工具结果", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-03T08:09:10Z") });
    const longMessage = `请使用 Bearer abc.def，${"很长的内容".repeat(200)}`;
    await tracer.record("run_started", {
      runId: "r1",
      sessionId: "s1",
      userInput: longMessage,
      provider: "openai-compatible",
      model: "test-model",
    });
    await tracer.record("model_request", {
      runId: "r1",
      sessionId: "s1",
      iteration: 1,
      modelCallId: "model-1",
      request: { system: "完整 System Prompt", messages: [{ role: "user", content: longMessage }], tools: [], maxTokens: 2_048 },
    });
    await tracer.record("model_response", {
      runId: "r1",
      sessionId: "s1",
      iteration: 1,
      modelCallId: "model-1",
      response: { content: [{ type: "text", text: "完成" }], usage: { input_tokens: 12, output_tokens: 3 } },
    });
    await tracer.record("tool_completed", {
      runId: "r1",
      sessionId: "s1",
      tool: "manage_memory",
      toolCallId: "tool-1",
      arguments: { action: "search", authorization: "secret" },
      result: { count: 1, text: "找到 1 条记录" },
      isError: false,
    });
    const records = await readTraceRecords(home);

    expect(records).toEqual([
      expect.objectContaining({ version: 2, type: "run_started", runId: "r1", sessionId: "s1", sequence: 1 }),
      expect.objectContaining({
        type: "model_request",
        modelCallId: "model-1",
        sequence: 2,
      }),
      expect.objectContaining({
        type: "model_response",
        modelCallId: "model-1",
        sequence: 3,
      }),
      expect.objectContaining({
        type: "tool_completed",
        toolCallId: "tool-1",
        sequence: 4,
        payload: expect.objectContaining({
          arguments: { action: "search", authorization: "[凭证已移除]" },
          result: { count: 1, text: "找到 1 条记录" },
        }),
      }),
    ]);
    expect(JSON.stringify(records[1]?.payload)).toContain("完整 System Prompt");
    expect(JSON.stringify(records[1]?.payload).length).toBeGreaterThan(1_000);
    expect(JSON.stringify(records[1]?.payload)).toContain("Bearer [凭证已移除]");
    expect(records[1]?.payload?.request).toMatchObject({ maxTokens: 2_048 });
    expect(records[2]?.payload?.response).toMatchObject({ usage: { input_tokens: 12, output_tokens: 3 } });
    expect(JSON.stringify(records)).not.toContain('"authorization":"secret"');
    expect(await readFile(join(home, "traces", "2026-09-03", "001-s1.jsonl"), "utf8"))
      .toContain('"type":"run_started"');
  });

  it("按日期目录与 Session 文件隔离记录", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-03T08:09:10Z") });
    await tracer.record("run_started", { runId: "r1", sessionId: "s1" });
    await tracer.record("run_started", { runId: "r2", sessionId: "s2" });
    await tracer.record("trace_read_error", { runId: "r3" });

    const dateDirectory = join(home, "traces", "2026-09-03");
    expect((await readdir(dateDirectory)).sort()).toEqual(["001-s1.jsonl", "002-s2.jsonl", "003-system.jsonl"]);
    expect((await readTraceFiles(home)).map((file) => file.path)).toEqual([
      "2026-09-03/001-s1.jsonl",
      "2026-09-03/002-s2.jsonl",
      "2026-09-03/003-system.jsonl",
    ]);
  });

  it("重启后继续写入原 Session 编号，并按限额保留最新事件", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const firstTracer = new JsonlTracer(home, { now: () => new Date("2026-09-03T08:00:00Z") });
    await firstTracer.record("run_started", { runId: "r1", sessionId: "s1" });

    let now = new Date("2026-09-03T09:00:00Z");
    const restartedTracer = new JsonlTracer(home, { now: () => now });
    await restartedTracer.record("run_completed", { runId: "r1", sessionId: "s1" });
    now = new Date("2026-09-03T10:00:00Z");
    await restartedTracer.record("run_started", { runId: "r2", sessionId: "s2" });

    const directory = join(home, "traces", "2026-09-03");
    expect((await readdir(directory)).sort()).toEqual(["001-s1.jsonl", "002-s2.jsonl"]);
    expect(await readTraceFiles(home, 1)).toEqual([
      expect.objectContaining({
        path: "2026-09-03/002-s2.jsonl",
        records: [expect.objectContaining({ runId: "r2" })],
      }),
    ]);
  });

  it("发现损坏的当日文件时切换到恢复文件", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const directory = join(home, "traces", "2026-09-03");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "001-s1.jsonl"), "broken\n", "utf8");
    const warning = vi.fn();
    const tracer = new JsonlTracer(home, { onWarning: warning, now: () => new Date("2026-09-03T08:09:10Z") });
    await tracer.record("run_completed", { runId: "r1", sessionId: "s1", iterations: 1 });

    expect(warning).toHaveBeenCalled();
    const recovered = (await readdir(directory)).find((file) => file.startsWith("001-s1.recovered-"));
    expect(recovered).toBeTruthy();
    expect(await readFile(join(directory, recovered!), "utf8")).toContain('"type":"run_completed"');
  });

  it("目录不存在时返回空数组，损坏行转换为可见错误", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    expect(await readTraceRecords(home)).toEqual([]);

    const directory = join(home, "traces", "2026-09-03");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "001-s1.jsonl"), '{"version":1,"type":"turn_end","timestamp":"2026-09-03T08:00:00Z","runId":"r1"}\n损坏\n', "utf8");
    expect(await readTraceRecords(home, 100)).toEqual([
      expect.objectContaining({ type: "turn_end", runId: "r1" }),
      expect.objectContaining({ type: "trace_read_error", payload: { file: "2026-09-03/001-s1.jsonl" } }),
    ]);
  });

  it("不读取根目录中的旧版按日 JSONL 文件", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const directory = join(home, "traces");
    await mkdir(directory);
    await writeFile(join(directory, "2026-09-03.jsonl"), '{"version":1,"type":"turn_end","timestamp":"2026-09-03T08:00:00Z","runId":"legacy"}\n', "utf8");

    expect(await readTraceRecords(home)).toEqual([]);
  });

  it("检索事件移除凭证并忽略未允许字段", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-03T08:09:10Z") });
    await tracer.record("retrieval", {
      sessionId: "s1",
      semantic: { query: "Bearer abc.def token-12345678", hits: [{ id: 1, bm25: -1 }] },
      sessionRecall: { mode: "none", sessions: [] },
      rawPrompt: "不能出现",
    });
    await tracer.flush();
    const [record] = await readTraceRecords(home, 0);

    expect(record?.runId).toEqual(expect.any(String));
    expect(JSON.stringify(record?.payload?.semantic)).toContain("凭证已移除");
    expect(JSON.stringify(record)).not.toContain("不能出现");
  });

  it("未知事件只保留关联标识", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const tracer = new JsonlTracer(home);
    await tracer.record("custom", { runId: "r1", sessionId: "s1", private: "内容" });
    expect(await readTraceRecords(home)).toEqual([
      expect.objectContaining({ type: "custom", runId: "r1", sessionId: "s1" }),
    ]);
    expect(JSON.stringify(await readTraceRecords(home))).not.toContain("内容");
  });
});
