import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryRuntime } from "../index.ts";
import type { AgentModelClient } from "../../agent-loop/agent-loop.ts";

const memories: MemoryRuntime[] = [];
afterEach(() => memories.splice(0).forEach((memory) => memory.close()));

it("聊天写入必须先检索，小模型把重复事实判为 noop", async () => {
  const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "memory-management-"))); memories.push(memory);
  const session = memory.createSession();
  const evidence = memory.startRun(session.id, "run", "我喜欢红茶");
  const old = await memory.createSemantic("饮品偏好", "喜欢红茶");
  const events: string[] = [];
  const client: AgentModelClient = { messages: { async create(request) {
    expect(String(request.messages[0]?.content)).toContain(`"id":${old.id}`);
    return { content: [{ type: "text", text: JSON.stringify({ action: "noop", reason: "已有相同事实", evidenceMessageIds: [evidence.id] }) }], stop_reason: "end_turn" };
  } } };
  const result = await memory.manageMemory({ intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶", evidenceMessageIds: [evidence.id] }, {
    client, model: "small", currentSessionId: session.id, runId: "run", observer: (kind) => { events.push(kind) },
  });
  expect(result.action).toBe("noop");
  expect(memory.listSemantic()).toHaveLength(1);
  expect(events.indexOf("memory_search_completed")).toBeLessThan(events.indexOf("memory_decision_completed"));
});

it("新增保存证据，更新保留 ID 和来源，不同事实可独立新增", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const created = await memory.manageMemory(candidate, { ...options, client: model(() => write("create", evidence.id)) });
  const second = memory.startRun(options.currentSessionId, "next", "我现在喜欢绿茶");
  const updated = await memory.manageMemory({ ...candidate, content: "现在喜欢绿茶", evidenceMessageIds: [second.id] }, {
    ...options, runId: "next", client: model(() => ({ ...write("update", second.id), targetId: created.targetId, content: "现在喜欢绿茶" })),
  });
  expect(updated.targetId).toBe(created.targetId);
  expect(memory.listSemantic()).toMatchObject([{ content: "现在喜欢绿茶", sources: [{ messageId: evidence.id }, { messageId: second.id }] }]);
  await memory.manageMemory({ ...candidate, attribute: "饮食约束", content: "对花生过敏" }, { ...options, client: model(() => ({ ...write("create", evidence.id), subject: "饮食约束", content: "对花生过敏" })) });
  expect(memory.listSemantic()).toHaveLength(2);
});

it.each(["lexical_only", "dense_only", "hybrid"] as const)("%s 管理检索保留重复候选，合并后只留一个 ID 且来源完整", async (mode) => {
  const { memory, candidate, options, evidence } = await setup();
  const first = await memory.manageMemory(candidate, { ...options, client: model(() => write("create", evidence.id)) });
  const secondEvidence = memory.startRun(options.currentSessionId, "second", "我上午喜欢喝红茶");
  const second = await memory.manageMemory({ ...candidate, evidenceMessageIds: [secondEvidence.id] }, { ...options, runId: "second", client: model(() => write("create", secondEvidence.id)) });
  await configureEmbedding(memory, mode);
  if (mode !== "lexical_only") expect(await memory.searchSemantic("红茶")).toHaveLength(1);
  const events: string[] = [];
  const result = await memory.manageMemory(candidate, { ...options, observer: (kind) => { events.push(kind) }, client: model((payload) => {
    expect(payload.relatedFacts.map((item: { id: number }) => item.id).sort()).toEqual([first.targetId, second.targetId]);
    return { ...write("merge", evidence.id), targetId: first.targetId, sourceIds: [second.targetId], content: "喜欢红茶，通常上午喝" };
  }) });
  expect(result).toMatchObject({ action: "merge", targetId: first.targetId, deletedIds: [second.targetId] });
  expect(memory.listSemantic()).toMatchObject([{ id: first.targetId, content: "喜欢红茶，通常上午喝", sources: [{ messageId: evidence.id }, { messageId: secondEvidence.id }] }]);
  expect((await memory.searchSemantic("红茶")).map((item) => item.id)).toEqual([first.targetId]);
  expect(events.includes("dense_retrieval_completed")).toBe(mode !== "lexical_only");
  expect(events.includes("rrf_completed")).toBe(mode === "hybrid");
});

it("合并写入向量失败会回滚内容、来源和索引，不删除冗余项", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const first = await memory.createSemantic("饮品偏好", "喜欢红茶");
  const second = await memory.createSemantic("饮品偏好", "上午喝红茶");
  await configureEmbedding(memory, "hybrid");
  const before = memory.listSemantic();
  memory.configureRetrieval({ mode: "hybrid", embedding: { profile, client: { async embed(texts, _tokens, context) {
    return texts.map((_text, index) => ({ index, vector: context.purpose === "memory_create" ? new UnserializableVector(1024) : vector() }));
  } } } });
  await expect(memory.manageMemory(candidate, { ...options, client: model(() => ({ ...write("merge", evidence.id), targetId: first.id, sourceIds: [second.id] })) })).rejects.toThrow();
  expect(memory.listSemantic()).toEqual(before);
  await configureEmbedding(memory, "lexical_only");
  expect(await memory.searchSemantic("红茶")).toHaveLength(2);
});

it("模型判断期间有并发新增时重新检索，避免使用过期的 create 决策", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let calls = 0; const events: string[] = [];
  const pending = memory.manageMemory(candidate, { ...options, observer: (kind) => { events.push(kind) }, client: model(async (payload) => {
    if (++calls === 1) { entered.resolve(); await release.promise; return write("create", evidence.id) }
    expect(payload.relatedFacts).toHaveLength(1);
    return { action: "noop", reason: "并发写入已包含同一事实", evidenceMessageIds: [evidence.id] };
  }) });
  await entered.promise;
  await memory.createSemantic("饮品偏好", "喜欢红茶");
  release.resolve();
  expect((await pending).action).toBe("noop");
  expect(calls).toBe(2); expect(events).toContain("memory_conflict"); expect(memory.listSemantic()).toHaveLength(1);
});

it("检索阶段发生版本变化时重新检索，持续冲突达到上限后停止", async () => {
  const { memory, candidate, options, evidence } = await setup();
  let calls = 0;
  await expect(memory.manageMemory(candidate, { ...options, observer: async (kind) => {
    if (kind === "memory_search_completed") await memory.createSemantic("饮品偏好", "喜欢红茶");
  }, client: model(() => { calls += 1; return write("create", evidence.id) }) })).rejects.toThrow("版本冲突");
  expect(calls).toBe(0); expect(memory.listSemantic()).toHaveLength(3);
});

it("向量计算期间有并发更新时重新判断，不覆盖新内容", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const old = await memory.createSemantic("饮品偏好", "喜欢红茶");
  await configureEmbedding(memory, "lexical_only");
  let injected = false; let calls = 0;
  memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: { async embed(texts) {
    if (!injected) { injected = true; await memory.updateSemantic(old.id, "饮品偏好", "现在喜欢绿茶") }
    return texts.map((_text, index) => ({ index, vector: vector() }));
  } } } });
  await memory.manageMemory(candidate, { ...options, client: model((payload) => {
    if (++calls === 1) return { ...write("update", evidence.id), targetId: old.id };
    expect(payload.relatedFacts[0]?.content).toBe("现在喜欢绿茶");
    return { action: "noop", reason: "新来源已经修正", evidenceMessageIds: [evidence.id] };
  }) });
  expect(calls).toBe(2); expect(memory.listSemantic()[0]?.content).toBe("现在喜欢绿茶");
});

it("检索失败不调用决策模型且不写入", async () => {
  const { memory, candidate, options, evidence } = await setup();
  await configureEmbedding(memory, "dense_only");
  memory.configureRetrieval({ mode: "dense_only", embedding: { profile, client: { async embed() { throw new Error("检索服务不可用") } } } });
  let calls = 0;
  await expect(memory.manageMemory(candidate, { ...options, client: model(() => { calls += 1; return write("create", evidence.id) }) })).rejects.toThrow("检索服务不可用");
  expect(calls).toBe(0); expect(memory.listSemantic()).toEqual([]);
});

it("取消小模型调用即停止等待，迟到响应不能写入", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const controller = new AbortController(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const pending = memory.manageMemory(candidate, { ...options, signal: controller.signal, client: model(async () => { entered.resolve(); await release.promise; return write("create", evidence.id) }) });
  await entered.promise; controller.abort(new Error("用户取消"));
  await expect(pending).rejects.toThrow("用户取消");
  release.resolve(); await Promise.resolve(); expect(memory.listSemantic()).toEqual([]);
});

it("提交时证据已被删除则不写入", async () => {
  const { memory, candidate, options, evidence } = await setup();
  await configureEmbedding(memory, "lexical_only");
  memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client: { async embed(texts) {
    memory.deleteSession(options.currentSessionId);
    return texts.map((_text, index) => ({ index, vector: vector() }));
  } } } });
  await expect(memory.manageMemory(candidate, { ...options, client: model(() => write("create", evidence.id)) })).rejects.toThrow("证据已删除");
  expect(memory.listSemantic()).toEqual([]);
});

it.each([
  { label: "错误原因代码", patch: { reasonCode: "explicit_forget" } },
  { label: "未知操作", patch: { action: "clarify" } },
  { label: "缺失原因", patch: { reason: "" } },
  { label: "非法证据", patch: { evidenceMessageIds: [999] } },
  { label: "重复证据", patch: { evidenceMessageIds: [1, 1] } },
  { label: "非正整数证据", patch: { evidenceMessageIds: [0] } },
  { label: "不存在的修改目标", patch: { action: "update", targetId: 999 } },
  { label: "错误类别", patch: { category: "temporary" } },
  { label: "非稳定事实", patch: { stable: false } },
  { label: "非长期价值", patch: { futureUseful: false } },
  { label: "空内容", patch: { content: " " } },
  { label: "未经忘记意图删除", patch: { action: "delete", targetId: 1 } },
  { label: "缺少合并来源", patch: { action: "merge", targetId: 1, sourceIds: [] } },
  { label: "合并自身", patch: { action: "merge", targetId: 1, sourceIds: [1] } },
  { label: "合并候选之外的记录", patch: { action: "merge", targetId: 1, sourceIds: [999] } },
])("拒绝 $label，不修改任何记忆", async ({ patch }) => {
  const { memory, candidate, options, evidence } = await setup();
  await memory.createSemantic("饮品偏好", "喜欢红茶"); const before = memory.listSemantic();
  await expect(memory.manageMemory(candidate, { ...options, client: model(() => ({ ...write("create", evidence.id), ...patch })) })).rejects.toThrow();
  expect(memory.listSemantic()).toEqual(before);
});

it("忘记意图不能转成新增，明确目标时直接删除", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const old = await memory.createSemantic("饮品偏好", "喜欢红茶");
  const forget = { ...candidate, intent: "forget" as const };
  await expect(memory.manageMemory(forget, { ...options, client: model(() => write("create", evidence.id)) })).rejects.toThrow("忘记意图");
  await expect(memory.manageMemory(forget, { ...options, client: model(() => ({ action: "delete", targetId: old.id, reason: "明确删除", evidenceMessageIds: [evidence.id] })) })).resolves.toMatchObject({ action: "delete", deletedIds: [old.id] });
  expect(await memory.searchSemantic("红茶")).toEqual([]);
});

it("拒绝其他 Session、Assistant 和失败历史回合的证据", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const other = memory.createSession();
  const foreign = memory.startRun(other.id, "other", "我喜欢红茶");
  await memory.completeRun(other.id, "other", [{ role: "assistant", content: "不能作为事实证据" }]);
  const client = model(() => write("create", evidence.id));
  for (const id of [foreign.id, foreign.id + 1, 999]) await expect(memory.manageMemory({ ...candidate, evidenceMessageIds: [id] }, { ...options, client })).rejects.toThrow("用户消息");
  await expect(memory.manageMemory(candidate, { ...options, runId: "different", client })).rejects.toThrow("用户消息");
  expect(memory.listSemantic()).toEqual([]);
});

it.each(["不是 JSON", "[]", "null"])("模型返回无效结构 %s 时不写入", async (text) => {
  const { memory, candidate, options } = await setup();
  await expect(memory.manageMemory(candidate, { ...options, client: { messages: { create: () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" }) } } })).rejects.toThrow();
  expect(memory.listSemantic()).toEqual([]);
});

it("模型截断时失败，事件不暴露候选内容或自由文本理由", async () => {
  const { memory, candidate, options, evidence } = await setup();
  const events: unknown[] = [];
  await memory.manageMemory(candidate, { ...options, observer: (_kind, fields) => { events.push(fields) }, client: model(() => ({ action: "noop", reason: "私人原因 喜欢红茶", evidenceMessageIds: [evidence.id] })) });
  expect(JSON.stringify(events)).not.toContain("红茶");
  await expect(memory.manageMemory(candidate, { ...options, client: { messages: { create: () => ({ content: [], stop_reason: "max_tokens" }) } } })).rejects.toThrow("截断");
});

async function setup() {
  const memory = new MemoryRuntime(await mkdtemp(join(tmpdir(), "memory-management-"))); memories.push(memory);
  const session = memory.createSession(); const evidence = memory.startRun(session.id, "run", "我喜欢红茶");
  return { memory, evidence,
    candidate: { intent: "remember" as const, subject: "用户", attribute: "饮品偏好", content: "喜欢红茶", evidenceMessageIds: [evidence.id] },
    options: { currentSessionId: session.id, runId: "run", model: "small" },
  };
}
function write(action: string, evidence: number) {
  return { action, reason: "用户证据支持此事实", evidenceMessageIds: [evidence], subject: "饮品偏好", content: "喜欢红茶", category: "preference", stable: true, futureUseful: true };
}
function model(decide: (payload: { relatedFacts: Array<{ id: number; content: string }> }) => unknown | Promise<unknown>): AgentModelClient {
  return { messages: { async create(request) {
    const result = await decide(JSON.parse(String(request.messages[0]?.content)));
    return { content: [{ type: "text", text: JSON.stringify(result) }], stop_reason: "end_turn" };
  } } };
}
const profile = { baseUrl: "https://embedding.invalid/v1", apiKey: "fake", model: "test", queryTemplate: "{text}", documentTemplate: "{text}", minimumSimilarity: 0.2 };
function vector() { const result = new Float32Array(1024); result[0] = 1; return result }
async function configureEmbedding(memory: MemoryRuntime, mode: "lexical_only" | "dense_only" | "hybrid") {
  const client = { async embed(texts: string[]) { return texts.map((_text, index) => ({ index, vector: vector() })) } };
  memory.configureRetrieval({ mode: "lexical_only", embedding: { profile, client }, allowIncompleteIndex: true });
  await memory.rebuildEmbeddings();
  memory.configureRetrieval({ mode, embedding: { profile, client } });
}

/** 在公开 Embedding 依赖边界注入持久化序列化故障，验证事务中途失败的回滚。 */
class UnserializableVector extends Float32Array {
  override get length(): number { throw new Error("向量序列化故障") }
}

it("OpenAI length 截断即使产生可解析 JSON 也不能提交", async () => {
  const { memory, candidate, options, evidence } = await setup();
  await expect(memory.manageMemory(candidate, { ...options, client: { messages: { create: () => ({ content: [{ type: "text", text: JSON.stringify(write("create", evidence.id)) }], stop_reason: "length" }) } } })).rejects.toThrow("截断");
  expect(memory.listSemantic()).toEqual([]);
});
