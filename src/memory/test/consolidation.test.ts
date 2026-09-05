import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRuntime, type MemoryCandidate, type MemoryManagementOptions } from "../index.ts";
import type { AgentModelClient } from "../../agent-loop/agent-loop.ts";

const memories: MemoryRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); for (const memory of memories.splice(0)) { memory.stopBackgroundTasks(); await memory.waitForBackgroundTasks(); memory.close(); } });

it("默认积攒六个 Session，新建第七个才产生一个批次；空对话与重复点击不累计", async () => {
  const memory = await setup();
  let current = memory.createConversation();
  expect(memory.createConversation(current.id).id).toBe(current.id);
  memory.startBackgroundTasks(async () => options(() => ({ candidates: [] })));
  for (let index = 0; index < 6; index++) {
    await complete(memory, current.id, `r${index}`);
    current = memory.createConversation(current.id);
    expect(memory.listBackgroundTasks()).toHaveLength(index === 5 ? 1 : 0);
    expect(memory.createConversation(current.id).id).toBe(current.id);
  }
  await memory.waitForBackgroundTasks();
  expect(memory.listBackgroundTasks()).toMatchObject([{ kind: "consolidation", status: "completed", attempts: 1 }]);
  expect(memory.listConsolidations()).toHaveLength(6);
  expect(memory.listConsolidations().every((run) => run.status === "completed")).toBe(true);
});

it("重启保留不足阈值的累计，仅恢复已入队批次", async () => {
  const home = await mkdtemp(join(tmpdir(), "memory-restart-"));
  let memory = new MemoryRuntime(home);
  let current = memory.createConversation();
  for (let index = 0; index < 4; index++) { await complete(memory, current.id, `r${index}`); current = memory.createConversation(current.id); }
  memory.close(); memory = new MemoryRuntime(home);
  memory.startBackgroundTasks(async () => options(() => ({ candidates: [] })));
  await memory.waitForBackgroundTasks();
  expect(memory.listBackgroundTasks()).toEqual([]);
  memory.stopBackgroundTasks();
  for (let index = 4; index < 6; index++) { await complete(memory, current.id, `r${index}`); current = memory.createConversation(current.id); }
  expect(memory.listBackgroundTasks()).toHaveLength(1);
  memory.close(); memory = new MemoryRuntime(home); memories.push(memory);
  memory.startBackgroundTasks(async () => options(() => ({ candidates: [] })));
  await memory.waitForBackgroundTasks();
  expect(memory.listConsolidations()).toHaveLength(6);
});

it("后台写入立即 queued，聊天归档不等待；重试已提交操作不会再调用模型或重复写入", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const memory = await setup(); const session = memory.createSession();
  const evidence = memory.startRun(session.id, "chat", "喜欢红茶");
  let release!: () => void; let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let modelCalls = 0; let failOnce = true;
  const config = { ...options(async () => { modelCalls++; entered(); await gate; return createDecision(evidence.id); }), currentSessionId: session.id, runId: "chat" };
  memory.startBackgroundTasks(async () => ({ ...config, observer: (kind) => { if (kind === "memory_change_completed" && failOnce) { failOnce = false; throw new Error("提交后中断"); } } }));
  const queued = memory.enqueueMemory(candidate(evidence.id), config);
  expect(queued).toMatchObject({ status: "queued" });
  await started;
  await memory.completeRun(session.id, "chat", [{ role: "assistant", content: "已接收" }]);
  expect(memory.listSemantic()).toEqual([]);
  release();
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "pending", attempts: 1 }));
  await vi.advanceTimersByTimeAsync(1000);
  await memory.waitForBackgroundTasks();
  expect(memory.listSemantic()).toHaveLength(1); expect(modelCalls).toBe(1);
  expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "completed", attempts: 2 });
});

it("一个 Session 失败不阻止其他 Session；最多三次且不重复提取已保存的候选", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const memory = await setup(); let current = memory.createConversation();
  const first = current.id;
  let extractionCalls = 0;
  const events: string[] = [];
  memory.startBackgroundTasks(async () => ({ ...options((payload) => {
    if (payload.evidence && !payload.candidate) { extractionCalls++; const ids = payload.evidence as Array<{ messageId: number; sessionId: string }>;
      return { candidates: ids[0]!.sessionId === first ? [candidate(ids[0]!.messageId)] : [] }; }
    throw new TypeError("模型不可用");
  }), observer: (kind) => { events.push(kind); } }));
  for (let i = 0; i < 2; i++) { await complete(memory, current.id, `r${i}`); current = memory.createConversation(current.id, 2); }
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "pending", attempts: 1 }));
  expect(memory.listConsolidations().map((run) => run.status).sort()).toEqual(["completed", "failed"]);
  await vi.advanceTimersByTimeAsync(3000); await memory.waitForBackgroundTasks();
  expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "failed", attempts: 3 });
  expect(extractionCalls).toBe(2);
  expect(events.filter((kind) => kind === "memory_task_retry")).toHaveLength(2);
  expect(events.at(-1)).toBe("memory_task_failed");
});

it("配置间隔边界校验且失败回合不占用 Session 配额", async () => {
  const memory = await setup(); const session = memory.createSession();
  memory.startRun(session.id, "failed", "未完成");
  expect(() => memory.createConversation(session.id, 0)).toThrow("整理间隔");
  expect(memory.listSessions()).toHaveLength(1);
  memory.createConversation(session.id, 1);
  expect(memory.listBackgroundTasks()).toEqual([]);
  expect(() => memory.createConversation("missing")).toThrow("不存在");
});

async function setup() { const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "memory-background-"))); memories.push(memory); return memory; }
async function complete(memory: MemoryRuntime, sessionId: string, runId: string) { memory.startRun(sessionId, runId, "我喜欢红茶"); await memory.completeRun(sessionId, runId, [{ role: "assistant", content: "收到" }]); }
function candidate(id: number): MemoryCandidate { return { intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶", evidenceMessageIds: [id] }; }
function createDecision(id: number) { return { action: "create", reason: "新偏好", reasonCode: "new_fact", subject: "饮品偏好", content: "喜欢红茶", evidenceMessageIds: [id], category: "preference", stable: true, futureUseful: true }; }
function options(decide: (payload: Record<string, unknown>) => unknown | Promise<unknown>): MemoryManagementOptions {
  const client: AgentModelClient = { messages: { async create(request) { return { content: [{ type: "text", text: JSON.stringify(await decide(JSON.parse(String(request.messages[0]?.content)))) }], stop_reason: "end_turn" }; } } };
  return { client, model: "small", currentSessionId: "" };
}
