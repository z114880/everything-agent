import { mkdtemp, readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { JsonlTracer, readTraceRecords } from "../jsonl-tracer.js";

describe("JSONL 运行记录", () => {
  it("按本地日期写入允许字段并排除完整内容", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-03T08:09:10Z") });
    await tracer.record("turn_start", { runId: "r1", sessionId: "s1", userMessage: "私人内容" });
    const records = await readTraceRecords(home);

    expect(records).toEqual([expect.objectContaining({ type: "turn_start", runId: "r1", sessionId: "s1" })]);
    expect(JSON.stringify(records)).not.toContain("私人内容");
  });

  it("发现损坏的当日文件时切换到恢复文件", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const directory = join(home, "traces");
    await mkdir(directory);
    await writeFile(join(directory, "2026-09-03.jsonl"), "broken\n", "utf8");
    const warning = vi.fn();
    const tracer = new JsonlTracer(home, { onWarning: warning, now: () => new Date("2026-09-03T08:09:10Z") });
    await tracer.record("turn_end", { runId: "r1", iterations: 1 });

    expect(warning).toHaveBeenCalled();
    const recovered = (await readdir(directory)).find((file) => file.includes(".recovered-"));
    expect(recovered).toBeTruthy();
    expect(await readFile(join(directory, recovered!), "utf8")).toContain('"type":"turn_end"');
  });

  it("目录不存在时返回空数组，损坏行转换为可见错误", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    expect(await readTraceRecords(home)).toEqual([]);

    const directory = join(home, "traces");
    await mkdir(directory);
    await writeFile(join(directory, "2026-09-03.jsonl"), '{"version":1,"type":"turn_end","timestamp":"t","runId":"r1"}\n损坏\n', "utf8");
    expect(await readTraceRecords(home, 100)).toEqual([
      expect.objectContaining({ type: "turn_end", runId: "r1" }),
      expect.objectContaining({ type: "trace_read_error", file: "2026-09-03.jsonl" }),
    ]);
  });

  it("检索事件移除凭证并忽略未允许字段", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-trace-"));
    const tracer = new JsonlTracer(home, { now: () => new Date("2026-09-03T08:09:10Z") });
    await tracer.record("retrieval", {
      sessionId: "s1",
      query: "Bearer abc.def token-12345678",
      semantic: [{ id: 1, score: -1 }],
      episodic: [],
      rawPrompt: "不能出现",
    });
    await tracer.flush();
    const [record] = await readTraceRecords(home, 0);

    expect(record?.runId).toEqual(expect.any(String));
    expect(record?.query).toContain("凭证已移除");
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
