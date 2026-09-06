import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryRuntime, type MemoryCandidate, type MemoryManagementOptions } from "../index.ts";
import type { AgentModelClient } from "../../agent-loop/agent-loop.ts";

const memories: MemoryRuntime[] = [];
afterEach(async () => { vi.useRealTimers(); for (const memory of memories.splice(0)) { memory.stopBackgroundTasks(); await memory.waitForBackgroundTasks(); memory.close(); } });

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

async function setup() { const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "memory-background-"))); memories.push(memory); return memory; }
async function complete(memory: MemoryRuntime, sessionId: string, runId: string) { memory.startRun(sessionId, runId, "我喜欢红茶"); await memory.completeRun(sessionId, runId, [{ role: "assistant", content: "收到" }]); }
function candidate(id: number): MemoryCandidate { return { intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶", evidenceMessageIds: [id] }; }
function createDecision(id: number) { return { action: "create", reason: "新偏好", reasonCode: "new_fact", subject: "饮品偏好", content: "喜欢红茶", evidenceMessageIds: [id], category: "preference", stable: true, futureUseful: true }; }
function options(decide: (payload: Record<string, unknown>) => unknown | Promise<unknown>): MemoryManagementOptions {
  const client: AgentModelClient = { messages: { async create(request) { return { content: [{ type: "text", text: JSON.stringify(await decide(JSON.parse(String(request.messages[0]?.content)))) }], stop_reason: "end_turn" }; } } };
  return { client, model: "small", currentSessionId: "" };
}

it("模型误判完全相同事实为 create 时仍只保存一条", async () => {
  const memory = await setup(); const session = memory.createSession(); const evidence = memory.startRun(session.id, "chat", "喜欢红茶");
  const config = { ...options(() => createDecision(evidence.id)), currentSessionId: session.id, runId: "chat" };
  const first = memory.enqueueMemory(candidate(evidence.id), config);
  const second = memory.enqueueMemory(candidate(evidence.id), config);
  expect(first.taskId).not.toBe(second.taskId);
  await memory.waitForBackgroundTasks();
  expect(memory.listSemantic()).toHaveLength(1);
  expect(memory.listBackgroundTasks().every((task) => task.status === "completed")).toBe(true);
});

it("真实进程在事实提交后退出，重启恢复不重放模型和数据库变更", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "memory-crash-"));
  const entry = new URL("../index.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { MemoryRuntime } from ${JSON.stringify(entry)};
    const memory = new MemoryRuntime(process.argv[1]);
    const session = memory.createSession();
    const evidence = memory.startRun(session.id, 'source', '我喜欢红茶');
    const options = { currentSessionId: session.id, runId: 'source', model: 'small',
      client: { messages: { create: () => ({ content: [{ type: 'text', text: JSON.stringify({ action: 'create', reason: '偏好', subject: '饮品偏好', content: '喜欢红茶', category: 'preference', stable: true, futureUseful: true, evidenceMessageIds: [evidence.id] }) }] }) } },
      observer: (kind) => { if (kind === 'memory_change_completed') process.exit(0); } };
    memory.enqueueMemory({ intent: 'remember', subject: '用户', attribute: '偏好', content: '喜欢红茶', evidenceMessageIds: [evidence.id] }, options);
    await memory.waitForBackgroundTasks();
    process.exit(1);
  `, home], { stdio: "pipe" });
  const memory = new MemoryRuntime(home); memories.push(memory);
  let calls = 0;
  memory.startBackgroundTasks(async () => options(() => { calls++; throw new Error("不应重放"); }));
  await memory.waitForBackgroundTasks();
  expect(calls).toBe(0); expect(memory.listSemantic()).toHaveLength(1);
  expect(memory.listBackgroundTasks()[0]?.status).toBe("completed");
});

it("每日仅一次，手动可额外执行且与已有任务互斥；跨日与重启保持去重", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 8, 6, 9));
  const home = await mkdtemp(join(tmpdir(), "daily-consolidation-"));
  let memory = new MemoryRuntime(home);
  const first = memory.consolidate("daily");
  expect(memory.consolidate("daily")).toEqual({ status: "active", taskId: first.taskId });
  expect(memory.consolidate("manual").taskId).toBe(first.taskId);
  memory.close(); memory = new MemoryRuntime(home); memories.push(memory);
  memory.startBackgroundTasks(async () => options(() => { throw new Error("空库不应调用模型"); }));
  await memory.waitForBackgroundTasks();
  expect(memory.consolidate("daily")).toEqual({ status: "already_ran", taskId: first.taskId });
  expect(memory.consolidate("manual").status).toBe("queued");
  await memory.waitForBackgroundTasks();
  vi.setSystemTime(new Date(2026, 8, 7, 9));
  expect(memory.consolidate("daily").status).toBe("queued");
  await memory.waitForBackgroundTasks();
  expect(memory.listBackgroundTasks()).toHaveLength(3);
  expect(memory.listConsolidations().every((run) => run.status === "completed")).toBe(true);
});

it("全量 facts 独立审查，不读取聊天；合并、替换与低质量清理直接提交", async () => {
  const memory = await setup();
  const first = await memory.createSemantic("饮品", "喜欢红茶");
  const duplicate = await memory.createSemantic("饮品", "偏爱红茶");
  const obsolete = await memory.createSemantic("居住", "以前住北京，现在住上海");
  const low = await memory.createSemantic("临时", "今天接口返回 200");
  const session = memory.createSession(); await complete(memory, session.id, "chat");
  let calls = 0;
  const events: string[] = [];
  memory.startBackgroundTasks(async () => ({ ...options((payload) => {
    calls++; expect(Object.keys(payload)).toEqual(["facts"]);
    expect(payload.facts).toHaveLength(4);
    return { decisions: [
      { action: "merge", targetId: first.id, sourceIds: [duplicate.id], subject: "饮品", content: "喜欢红茶", reasonCode: "redundant" },
      { action: "update", targetId: obsolete.id, subject: "居住", content: "现在住上海", reasonCode: "superseded" },
      { action: "delete", targetId: low.id, reasonCode: "not_durable" },
    ], unresolvedConflicts: [] };
  }), observer: (kind) => { events.push(kind); } }));
  memory.consolidate(); await memory.waitForBackgroundTasks();
  expect(calls).toBe(1);
  expect(memory.listSemantic().map((fact) => fact.content).sort()).toEqual(["喜欢红茶", "现在住上海"]);
  expect(memory.listConsolidations()[0]).toMatchObject({ status: "completed", totalBatches: 1, completedBatches: 1, factsUpdated: 1, factsDeleted: 1, factsMerged: 1 });
  expect(events.indexOf("consolidation_snapshot")).toBeLessThan(events.indexOf("consolidation_model_started"));
  expect(events.indexOf("consolidation_reviewed")).toBeLessThan(events.indexOf("consolidation_change"));
  expect(events).toEqual(["consolidation_started", "consolidation_batch_started", "consolidation_snapshot", "consolidation_model_started", "consolidation_model_completed", "consolidation_reviewed", ...Array(3).fill("consolidation_change"), "consolidation_batch_completed", "consolidation_completed"]);
});

it("有界分批覆盖全部事实及跨批次组合，未解决冲突保留事实", async () => {
  const memory = await setup();
  const ids: number[] = [];
  for (let i = 0; i < 4; i++) ids.push((await memory.createSemantic(`属性${i}`, `事实${i}`)).id);
  const seen: number[][] = [];
  memory.startBackgroundTasks(async () => ({ ...options((payload) => {
    const facts = payload.facts as Array<{ id: number }>;
    seen.push(facts.map((fact) => fact.id));
    return { decisions: [], unresolvedConflicts: [facts.map((fact) => fact.id)] };
  }), modelContextWindow: 4096, tokenEstimator: { estimateText: () => 0, estimateRequest: (request) => JSON.parse(String(request.messages[0]!.content)).facts.length * 1000 } }));
  memory.consolidate(); await memory.waitForBackgroundTasks();
  expect(seen).toHaveLength(6);
  for (const left of ids) for (const right of ids) expect(seen.some((batch) => batch.includes(left) && batch.includes(right))).toBe(true);
  expect(memory.listSemantic()).toHaveLength(4);
  expect(memory.listConsolidations()[0]).toMatchObject({ totalBatches: 6, completedBatches: 6, unresolvedConflicts: 6 });
});

it("提交后 observer 失败重试不重放修改和模型，检查点不保存旧事实正文", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const memory = await setup();
  const fact = await memory.createSemantic("临时", "旧事实敏感正文");
  let calls = 0; let fail = true;
  const attempts: string[][] = [[], []];
  memory.startBackgroundTasks(async () => ({ ...options(() => { calls++; return { decisions: [{ action: "delete", targetId: fact.id, reasonCode: "not_durable" }], unresolvedConflicts: [] }; }), observer: (kind, event) => { attempts[Number(event.attempt) - 1]!.push(kind); if (kind === "consolidation_change" && fail) { fail = false; throw new Error("提交后断开"); } } }));
  memory.consolidate();
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]?.status).toBe("pending"));
  await vi.advanceTimersByTimeAsync(3000); await memory.waitForBackgroundTasks();
  expect(calls).toBe(1); expect(memory.listSemantic()).toEqual([]);
  expect(attempts[1]).toEqual(["consolidation_started", "consolidation_batch_started", "consolidation_reviewed", "consolidation_batch_completed", "consolidation_completed"]);
  expect(memory.listConsolidations()[0]).toMatchObject({ status: "completed", factsDeleted: 1 });
});

it("模型期间用户更新事实使旧建议失效，重试重新审查", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const memory = await setup(); const fact = await memory.createSemantic("地点", "北京");
  let calls = 0;
  memory.startBackgroundTasks(async () => options(async () => {
    calls++;
    if (calls === 1) { await memory.updateSemantic(fact.id, "地点", "上海"); return { decisions: [{ action: "delete", targetId: fact.id, reasonCode: "superseded" }], unresolvedConflicts: [] }; }
    return { decisions: [], unresolvedConflicts: [] };
  }));
  memory.consolidate();
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "pending", attempts: 1 }));
  await vi.advanceTimersByTimeAsync(3000); await memory.waitForBackgroundTasks();
  expect(calls).toBe(2); expect(memory.listSemantic()[0]?.content).toBe("上海");
});

it.each([
  { decisions: [{ action: "create" }], unresolvedConflicts: [] },
  { decisions: [{ action: "delete", targetId: 999, reasonCode: "not_durable" }], unresolvedConflicts: [] },
  { decisions: [{ action: "delete", targetId: 1, reasonCode: "correction" }], unresolvedConflicts: [] },
  { decisions: [{ action: "merge", targetId: 1, sourceIds: [1], reasonCode: "redundant" }], unresolvedConflicts: [] },
  { decisions: [{ action: "update", targetId: 1, reasonCode: "correction", content: "" }], unresolvedConflicts: [] },
  { decisions: [], unresolvedConflicts: [[999, 1]] },
  { decisions: [] },
])("无效模型建议不能修改事实，最多重试三次：%j", async (plan) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const memory = await setup(); await memory.createSemantic("偏好", "红茶");
  memory.startBackgroundTasks(async () => options(() => plan));
  memory.consolidate();
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "pending", attempts: 1 }));
  await vi.advanceTimersByTimeAsync(3000); await memory.waitForBackgroundTasks();
  expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "failed", attempts: 3 });
  expect(memory.listSemantic()).toHaveLength(1);
});

it.each(["单条超限", "子任务超限", "输出截断", "调用超时"])("%s 明确失败，不截断输入或无限执行", async (scenario) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const memory = await setup();
  for (let i = 0; i < (scenario === "子任务超限" ? 24 : 2); i++) await memory.createSemantic(`属性${i}`, "完整正文");
  let calls = 0;
  const config = options(() => ({ decisions: [], unresolvedConflicts: [] }));
  memory.startBackgroundTasks(async () => ({ ...config, modelContextWindow: 4096,
    tokenEstimator: { estimateText: () => 0, estimateRequest: (request) => scenario === "单条超限" ? 9000 : JSON.parse(String(request.messages[0]!.content)).facts.length * 1000 },
    client: { messages: { async create(request) {
      calls++;
      if (scenario === "输出截断") return { content: [], stop_reason: "max_tokens" };
      if (scenario === "调用超时") throw new DOMException("模型超时", "TimeoutError");
      return config.client.messages.create(request);
    } } },
  }));
  memory.consolidate();
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "pending", attempts: 1 }));
  await vi.advanceTimersByTimeAsync(3000); await memory.waitForBackgroundTasks();
  expect(memory.listBackgroundTasks()[0]).toMatchObject({ status: "failed", attempts: 3 });
  expect(calls).toBe(scenario === "输出截断" || scenario === "调用超时" ? 3 : 0);
  expect(memory.listSemantic()).toHaveLength(scenario === "子任务超限" ? 24 : 2);
});

it("新建会话不触发整理，非法来源被拒绝", async () => {
  const memory = await setup(); let session = memory.createConversation();
  for (let i = 0; i < 7; i++) { await complete(memory, session.id, `r${i}`); session = memory.createConversation(session.id); }
  expect(memory.listBackgroundTasks()).toEqual([]);
  expect(memory.createConversation(session.id).id).toBe(session.id);
  expect(() => memory.createConversation("missing")).toThrow("不存在");
  // @ts-expect-error 公开入口需要拒绝未受支持的触发来源。
  expect(() => memory.consolidate("session_batch")).toThrow("触发来源无效");
});

it("进程在 consolidation 提交后退出，恢复检查点不重放模型与已删除事实", async () => {
  const { execFileSync } = await import("node:child_process");
  const home = await mkdtemp(join(tmpdir(), "consolidation-crash-"));
  const entry = new URL("../index.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { MemoryRuntime } from ${JSON.stringify(entry)};
    const memory = new MemoryRuntime(process.argv[1]);
    const fact = await memory.createSemantic('临时', '应被清理的内容');
    memory.startBackgroundTasks(async () => ({ currentSessionId: '', model: 'small',
      client: { messages: { create: () => ({ content: [{ type: 'text', text: JSON.stringify({ decisions: [{ action: 'delete', targetId: fact.id, reasonCode: 'not_durable' }], unresolvedConflicts: [] }) }] }) } },
      observer: (kind) => { if (kind === 'consolidation_change') process.exit(0); } }));
    memory.consolidate('daily');
    await memory.waitForBackgroundTasks();
    process.exit(1);
  `, home], { stdio: "pipe" });
  const memory = new MemoryRuntime(home); memories.push(memory);
  let calls = 0;
  memory.startBackgroundTasks(async () => options(() => { calls++; throw new Error("不应重放模型"); }));
  await memory.waitForBackgroundTasks();
  expect(calls).toBe(0); expect(memory.listSemantic()).toEqual([]);
  expect(memory.listConsolidations()[0]).toMatchObject({ status: "completed", factsDeleted: 1 });
  expect(memory.consolidate("daily").status).toBe("already_ran");
});


it("整理事件只关联运行与尝试，空库没有虚构批次", async () => {
  const memory = await setup();
  const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
  memory.startBackgroundTasks(async () => ({ ...options(() => { throw new Error("空库不调用模型"); }), observer: (kind, event) => { events.push({ kind, event }); } }));
  const queued = memory.consolidate("manual");
  await memory.waitForBackgroundTasks();
  expect(events.map(({ kind }) => kind)).toEqual(["consolidation_started", "consolidation_completed"]);
  expect(events[0]?.event).toMatchObject({ runId: queued.taskId, attempt: 1, trigger: "manual", createdAt: expect.any(String) });
  expect(events[1]?.event).toEqual({ runId: queued.taskId, attempt: 1, completedBatches: 0 });
  for (const { event } of events) {
    expect(event).not.toHaveProperty("taskId");
    expect(event).not.toHaveProperty("taskKind");
    expect(event).not.toHaveProperty("taskCreatedAt");
  }
});

it("模型失败先关闭批次再重试，尝试和调用关联明确且最终失败有终态", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const memory = await setup(); await memory.createSemantic("偏好", "红茶");
  const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
  memory.startBackgroundTasks(async () => ({ ...options(() => { throw new TypeError("模型失败"); }), observer: (kind, event) => { events.push({ kind, event }); } }));
  const queued = memory.consolidate("manual");
  await vi.waitFor(() => expect(memory.listBackgroundTasks()[0]?.status).toBe("pending"));
  await vi.advanceTimersByTimeAsync(3000); await memory.waitForBackgroundTasks();
  for (let attempt = 1; attempt <= 3; attempt++) {
    const current = events.filter(({ event }) => event.attempt === attempt);
    expect(current.map(({ kind }) => kind)).toEqual([
      "consolidation_started", "consolidation_batch_started", "consolidation_snapshot",
      "consolidation_model_started", "consolidation_model_failed", "consolidation_batch_failed",
      attempt < 3 ? "consolidation_retry" : "consolidation_failed",
    ]);
    expect(current.every(({ event }) => event.runId === queued.taskId && !("taskId" in event))).toBe(true);
    expect(current[3]?.event.modelCallId).toBe(current[4]?.event.modelCallId);
    expect(current[5]?.event).toMatchObject({ batchIndex: 0, totalBatches: 1, errorType: "TypeError" });
  }
});
