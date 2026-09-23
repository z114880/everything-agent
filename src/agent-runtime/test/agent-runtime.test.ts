import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRuntime, type AgentRuntime, type AgentSettingsInput } from "../index.ts";
import type { ModelRequest, ModelResponse } from "../../agent-loop/agent-loop.ts";

const { create, createModelClient } = vi.hoisted(() => ({
  create: vi.fn<(request: ModelRequest) => Promise<ModelResponse>>(),
  createModelClient: vi.fn((_config: unknown) => ({ messages: { create: (...args: [ModelRequest]) => create(...args) } })),
}));
vi.mock("../../model/model-client.ts", () => ({ createModelClient }));
const runtimes: AgentRuntime[] = [];
const homes: string[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
  create.mockReset();
  createModelClient.mockClear();
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "agent-runtime-"));
  const home = join(root, ".everything");
  await mkdir(home);
  homes.push(root);
  const paths = { home, defaultSystemPromptPath: join(root, "default.md") };
  await writeFile(paths.defaultSystemPromptPath, "你是个人助理");
  await writeFile(join(home, ".env"), [
    'EVERYTHING_AGENT_API_KEY="agent-key"', 'EVERYTHING_SMALL_API_KEY="small-key"', "",
  ].join("\n"));
  await writeFile(join(home, "config.json"), `${JSON.stringify({
    models: {
      agent: { provider: "openai-compatible", model: "test", baseUrl: "https://agent.example/v1" },
      small: { provider: "anthropic", model: "small-test", baseUrl: "https://small.example" },
    },
  })}\n`);
  const runtime = createAgentRuntime(paths);
  runtimes.push(runtime);
  return runtime;
}
const response = (text: string): ModelResponse => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });
function model(reply = "你好") {
  create.mockImplementation(async (request) => response((Array.isArray(request.tools) && request.tools.length > 0) ? reply : '{"intent":"none"}'));
}
const options = () => ({ observer: () => {}, signal: new AbortController().signal });
const modelSettings = (): Pick<AgentSettingsInput, "agentModel" | "smallModel"> => ({
  agentModel: { provider: "openai-compatible", model: "test", baseUrl: "https://agent.example/v1" },
  smallModel: { provider: "anthropic", model: "small-test", baseUrl: "https://small.example" },
});

describe("个人助理 Runtime", () => {
  it("自定义程序性记忆后仍注入运行时记忆策略，且不写回用户规则", async () => {
    model();
    const runtime = await setup();
    await runtime.saveSystemPrompt("回答使用简洁中文");
    const session = await runtime.createSession();
    await runtime.run({ sessionId: session.id, prompt: "你好" }, options());
    const request = create.mock.calls.map(([request]) => request).find((request) => Array.isArray(request.tools) && request.tools.length > 0);
    expect(request?.system).toContain("回答使用简洁中文");
    expect(request?.system).toContain("## Semantic Memory 策略");
    expect(request?.system).toContain("必须调用 manage_memory submit");
    expect(request?.system).toContain("content 必须由当前用户原文直接支持");
    expect(request?.system).toContain("不能声称最终写入成功");
    expect(request?.system).toContain("不要重复搜索");
    expect(await runtime.readSystemPrompt()).toBe("回答使用简洁中文\n");
  });

  it("Loop 超过一分钟仍可完成，并记录五分钟超时预算", async () => {
    const runtime = await setup();
    const session = await runtime.createSession();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    create.mockImplementation(async (request) => {
      if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
      await vi.advanceTimersByTimeAsync(299_999);
      return response("完成");
    });
    try {
      await expect(runtime.run({ sessionId: session.id, prompt: "执行较长任务" }, options()))
        .resolves.toMatchObject({ reply: "完成" });
      const records = (await runtime.readTraces()).flatMap((file) => file.records);
      expect(records.find((record) => record.type === "run_started")?.payload)
        .toMatchObject({ settings: { timeoutMs: 300_000 } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("consolidation 只产生独立整理日志，不产生 system.jsonl", async () => {
    const runtime = await setup();
    await runtime.clearModelApiKey("smallModel");
    const fact = await runtime.memory.createSemantic("饮品", "喜欢红茶");
    create.mockResolvedValue(response(JSON.stringify({
      decisions: [{ action: "delete", targetId: fact.id, reasonCode: "not_durable" }],
      unresolvedConflicts: [],
    })));

    const task = await runtime.consolidate("manual");
    await runtime.memory.waitForBackgroundTasks();

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "test" }));
    expect(runtime.memory.listSemantic()).toEqual([]);
    const files = await runtime.readTraces();
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toContain(`consolidation-${task!.taskId}.jsonl`);
    expect(files[0]?.records.map((record) => record.type)).toEqual([
      "consolidation_started", "consolidation_batch_started", "consolidation_snapshot",
      "consolidation_model_started", "consolidation_model_completed", "consolidation_reviewed",
      "consolidation_change", "consolidation_batch_completed", "consolidation_completed",
    ]);
  });

  it("consolidation 无需修改时在独立日志中明确记录 noop", async () => {
    const runtime = await setup();
    await runtime.memory.createSemantic("饮品", "喜欢红茶");
    create.mockResolvedValue(response(JSON.stringify({
      decisions: [],
      unresolvedConflicts: [],
      outcome: { action: "noop", reasonCode: "no_change" },
    })));

    await runtime.consolidate("manual");
    await runtime.memory.waitForBackgroundTasks();

    const files = await runtime.readTraces();
    const change = files[0]?.records.find((record) => record.type === "consolidation_change");
    expect(change?.payload).toMatchObject({ action: "noop", reasonCode: "no_change", deletedIds: [] });
    expect(runtime.memory.listConsolidations()[0]).toMatchObject({ factsSkipped: 1 });
  });

  it("独立实例隔离会话、规则与密钥，保存不修改进程环境", async () => {
    vi.stubEnv("UNRELATED_TEST_KEY", "inherited");
    const first = await setup(); const second = await setup();
    first.createSession();
    await first.saveSystemPrompt("新规则");
    await first.clearModelApiKey("agentModel");
    expect(first.memory.listSessions()).toHaveLength(1);
    expect(second.memory.listSessions()).toHaveLength(0);
    expect(await first.readSystemPrompt()).toBe("新规则\n");
    expect(await second.readSystemPrompt()).toBe("你是个人助理");
    expect((await first.getSettings()).agentModel.keyConfigured).toBe(false);
    expect((await second.getSettings()).agentModel.keyConfigured).toBe(true);
    expect(process.env.UNRELATED_TEST_KEY).toBe("inherited");
  });

  it("通过公开接口执行回合，保存工作记忆并关联可观察事件", async () => {
    model();
    const runtime = await setup(); const session = await runtime.createSession();
    const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
    const result = await runtime.run({ sessionId: session.id, prompt: "你好" }, {
      ...options(), observer: (kind, event) => { events.push({ kind, event }); },
    });
    expect(result).toMatchObject({ reply: "你好", model: "test", provider: "openai-compatible", toolCallCount: 0 });
    expect(createModelClient.mock.calls.map(([config]) => config)).toEqual([
      { provider: "openai-compatible", model: "test", baseUrl: "https://agent.example/v1", apiKey: "agent-key" },
      { provider: "anthropic", model: "small-test", baseUrl: "https://small.example", apiKey: "small-key" },
    ]);
    expect(runtime.memory.getWorkingMemory(session.id)).toHaveLength(2);
    const kinds = events.map(({ kind }) => kind);
    expect(kinds.indexOf("gate_start")).toBeLessThan(kinds.indexOf("gate_end"));
    expect(kinds.indexOf("context_assembled")).toBeLessThan(kinds.indexOf("model_request"));
    expect(kinds.indexOf("model_request")).toBeLessThan(kinds.indexOf("model_response"));
    expect(events.every(({ event }) => event.runId === result.runId && event.sessionId === session.id)).toBe(true);
  });

  it("每个新回合按最新配置向模型公开可用工具", async () => {
    const runtime = await setup();
    await runtime.saveToolSettings({ getCurrentTimeEnabled: false, searchWebEnabled: true, tavilyApiKey: "tvly-secret" });
    const session = await runtime.createSession();
    const toolNames: string[][] = [];
    create.mockImplementation(async (request) => {
      if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
      toolNames.push(request.tools.map((tool: { name: string }) => tool.name));
      return response("完成");
    });

    await runtime.run({ sessionId: session.id, prompt: "搜索最新消息" }, options());

    expect(toolNames[0]).toEqual(expect.arrayContaining(["manage_memory", "session_search", "session_read", "read_skill", "search_web"]));
    expect(toolNames[0]).not.toContain("get_current_time");
  });

  it("每轮发现最新 Skills，并通过 read_skill 按需加载正文和记录事件", async () => {
    const runtime = await setup();
    await runtime.saveSkill({ name: "daily-plan", description: "规划当天任务", instructions: "先列出三件要事" });
    const session = await runtime.createSession();
    let agentCalls = 0;
    create.mockImplementation(async (request) => {
      if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
      agentCalls += 1;
      if (agentCalls === 1) {
        expect(request.system).toContain("- daily-plan: 规划当天任务");
        expect(request.system).not.toContain("先列出三件要事");
        expect(request.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read_skill" })]));
        return { content: [{ type: "tool_use", id: "skill-tool", name: "read_skill", input: { name: "daily-plan" } }], stop_reason: "tool_use" };
      }
      expect(JSON.stringify(request.messages)).toContain("先列出三件要事");
      return response("计划完成");
    });
    const events: Array<{ kind: string; event: Record<string, unknown> }> = [];

    const result = await runtime.run({ sessionId: session.id, prompt: "规划今天" }, {
      ...options(), observer: (kind, event) => { events.push({ kind, event }); },
    });

    expect(result.reply).toBe("计划完成");
    expect(events.find((item) => item.kind === "skills_discovered")?.event).toMatchObject({ count: 1 });
    expect(events.find((item) => item.kind === "skill_loaded")?.event).toMatchObject({ skill: "daily-plan", instructionLength: 7 });
    expect(events.find((item) => item.kind === "tool_completed")?.event.result).toEqual({ name: "daily-plan", description: "规划当天任务", instructionLength: 7 });
    expect(JSON.stringify(events.filter((item) => ["skill_loaded", "tool_completed"].includes(item.kind)))).not.toContain("先列出三件要事");
    const kinds = events.map((item) => item.kind);
    expect(kinds.indexOf("skills_discovered")).toBeLessThan(kinds.indexOf("model_request"));
    expect(kinds.indexOf("tool_started")).toBeLessThan(kinds.indexOf("skill_loaded"));
    expect(kinds.indexOf("skill_loaded")).toBeLessThan(kinds.indexOf("tool_completed"));
    const traceTypes = (await runtime.readTraces()).flatMap((file) => file.records.map((record) => record.type));
    expect(traceTypes).toEqual(expect.arrayContaining(["skills_discovered", "skill_loaded", "tool_completed"]));
  });

  it("活动回合阻止清理和关闭，同会话排队后读取前一回合结果", async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let calls = 0;
    create.mockImplementation(async (request) => {
      if (!(Array.isArray(request.tools) && request.tools.length > 0)) return response('{"intent":"none"}');
      if (++calls === 1) { entered.resolve(); await release.promise; }
      return response("完成");
    });
    const runtime = await setup(); const session = await runtime.createSession();
    const first = runtime.run({ sessionId: session.id, prompt: "第一问" }, options());
    await entered.promise;
    const second = runtime.run({ sessionId: session.id, prompt: "第二问" }, options());
    await expect(runtime.clearLocalAgentData()).rejects.toThrow("仍有 Agent 回合正在运行");
    await expect(runtime.close()).rejects.toThrow("仍有任务正在运行");
    release.resolve();
    await Promise.all([first, second]);
    const requests = create.mock.calls.map(([request]) => request).filter((request) => (Array.isArray(request.tools) && request.tools.length > 0));
    expect(requests[1]?.messages).toEqual(expect.arrayContaining([{ role: "user", content: "第一问" }]));
    expect(runtime.memory.getWorkingMemory(session.id)).toHaveLength(4);
    await runtime.saveSystemPrompt("保留规则");
    const settingsBeforeClear = await runtime.getSettings();
    await runtime.clearLocalAgentData();
    expect(await runtime.getSettings()).toEqual(settingsBeforeClear);
    expect(runtime.memory.listSessions()).toEqual([]);
    expect(await runtime.readSystemPrompt()).toBe("保留规则\n");
  });

  it("失败回合释放会话锁，后续回合仍能完成；关闭后拒绝重新创建资源", async () => {
    const runtime = await setup(); const session = await runtime.createSession();
    await expect(runtime.run({ sessionId: session.id, prompt: "" }, options())).rejects.toThrow("不能为空");
    model();
    await expect(runtime.run({ sessionId: session.id, prompt: "失败回合" }, {
      ...options(), observer: (kind) => { if (kind === "model_request") throw new Error("事件接收失败"); },
    })).rejects.toThrow("事件接收失败");
    expect(runtime.memory.getWorkingMemory(session.id)).toEqual([]);
    await runtime.run({ sessionId: session.id, prompt: "继续" }, options());
    await runtime.close();
    await expect(runtime.createSession()).rejects.toThrow("已关闭");
    await expect(runtime.listSkills()).rejects.toThrow("已关闭");
    await expect(runtime.saveSkill({ name: "closed", description: "关闭", instructions: "关闭" })).rejects.toThrow("已关闭");
    await expect(runtime.run({ sessionId: session.id, prompt: "继续" }, options())).rejects.toThrow("已关闭");
  });
});

describe("Runtime 配置与维护", () => {
  it("输出与迭代预算持久化并控制实际请求和运行日志", async () => {
    const runtime = await setup();
    // Recall 总额不是独立旋钮：它固定是 Model Context Window 的 25%，随之变化。
    expect(await runtime.getSettings()).toMatchObject({ maxTokens: 32_768, maxIterations: 100, modelContextWindow: 262_144, sessionRecallTokenLimit: 65_536 });
    await runtime.saveAgentSettings({ ...modelSettings(), maxTokens: 8_192, maxIterations: 12, modelContextWindow: 65_536 });
    expect(await runtime.getSettings()).toMatchObject({ maxTokens: 8_192, maxIterations: 12, sessionRecallTokenLimit: 16_384 });
    const config = JSON.parse(await readFile(join(homes.at(-1)!, ".everything", "config.json"), "utf8"));
    expect(config).toMatchObject({ maxTokens: 8_192, maxIterations: 12 });
    let calls = 0;
    create.mockImplementation(async (request) => {
      if (!Array.isArray(request.tools) || !request.tools.length) return response('{"intent":"none"}');
      expect(request.max_tokens).toBe(8_192);
      calls++;
      return { content: [{ type: "tool_use", id: `call-${calls}`, name: "get_current_time", input: {} }], stop_reason: "tool_calls" };
    });
    const session = await runtime.createSession();
    await expect(runtime.run({ sessionId: session.id, prompt: "查看时间" }, options()))
      .resolves.toMatchObject({ iterations: 12, stopReason: "max_iterations" });
    expect(calls).toBe(12);
    const records = (await runtime.readTraces()).flatMap((file) => file.records);
    expect(records.find((record) => record.type === "run_started")?.payload)
      .toMatchObject({ settings: { maxTokens: 8_192, maxIterations: 12 } });
    expect((await runtime.resetRuntimeSettings()).settings).toMatchObject({ maxTokens: 32_768, maxIterations: 100, modelContextWindow: 262_144, sessionRecallTokenLimit: 65_536 });
  });

  it("保存完整配置、恢复预算并安全公开密钥状态", async () => {
    const runtime = await setup();
    const { settings } = await runtime.saveAgentSettings({
      agentModel: { provider: "openai-compatible", model: "main", apiKey: "agent-secret", baseUrl: "https://agent.example/v1" },
      smallModel: { provider: "anthropic", model: "small", apiKey: "small-secret", baseUrl: "https://small.example" },
      force: true,
      sessionSearchWindow: 3, sessionRecallEntryTokenLimit: 512,
      modelContextWindow: 8192,
      retrievalMode: "lexical_only", embeddingBaseUrl: "https://example.com/v1",
      embeddingApiKey: "embedding-key", embeddingModel: "embedding",
      embeddingQueryTemplate: "问题：{text}", embeddingDocumentTemplate: "文档：{text}",
      embeddingMinimumSimilarity: 0.5,
    });
    expect(settings).toMatchObject({
      agentModel: { provider: "openai-compatible", model: "main", keyLast4: "cret" },
      smallModel: { provider: "anthropic", model: "small", keyLast4: "cret" },
      embeddingKeyConfigured: true, sessionSearchWindow: 3,
      sessionRecallEntryTokenLimit: 512, sessionRecallTokenLimit: 2_048,
    });
    expect(JSON.stringify(settings)).not.toContain("agent-secret");
    expect(JSON.stringify(settings)).not.toContain("small-secret");
    const env = await readFile(join(homes.at(-1)!, ".everything", ".env"), "utf8");
    expect(env).toContain('EVERYTHING_AGENT_API_KEY="agent-secret"');
    expect(env).toContain('EVERYTHING_SMALL_API_KEY="small-secret"');
    expect(env).not.toContain("OPENAI_API_KEY");
    const config = await readFile(join(homes.at(-1)!, ".everything", "config.json"), "utf8");
    expect(config).toContain('"model": "main"');
    expect(config).not.toContain("agent-secret");
    expect((await runtime.resetRuntimeSettings()).settings.sessionSearchWindow).toBe(5);
    expect((await runtime.clearEmbeddingApiKey()).settings).toMatchObject({ retrievalMode: "lexical_only", embeddingKeyConfigured: false });
    expect(runtime.cancelEmbeddingIndexRebuild()).toEqual({ cancelled: false });
    await runtime.prepareMemory();
    expect(await runtime.readTraces()).toEqual(expect.any(Array));
    await runtime.start();
    await runtime.start();
  });

  it("保存工具开关与 Tavily 密钥，并且公开结果不泄露凭证", async () => {
    const runtime = await setup();
    const catalog = await runtime.saveToolSettings({
      getCurrentTimeEnabled: false,
      searchWebEnabled: true,
      tavilyApiKey: "tvly-runtime-secret",
    });
    expect(catalog.tools.find((tool) => tool.name === "get_current_time")).toMatchObject({ enabled: false, configurable: true });
    expect(catalog.tools.find((tool) => tool.name === "manage_memory")).toMatchObject({ enabled: true, configurable: false });
    expect(catalog.tools.find((tool) => tool.name === "search_web")).toMatchObject({ enabled: true, configured: true });
    expect(catalog.tavily).toEqual({ keyConfigured: true, keyLast4: "cret" });
    expect(JSON.stringify(catalog)).not.toContain("tvly-runtime-secret");
    const env = await readFile(join(homes.at(-1)!, ".everything", ".env"), "utf8");
    expect(env).toContain('TAVILY_API_KEY="tvly-runtime-secret"');
    const config = JSON.parse(await readFile(join(homes.at(-1)!, ".everything", "config.json"), "utf8"));
    expect(config.tools).toEqual({
      getCurrentTimeEnabled: false, searchWebEnabled: true, runTerminalEnabled: false,
    });

    const cleared = await runtime.saveToolSettings({ getCurrentTimeEnabled: true, searchWebEnabled: false, clearTavilyApiKey: true });
    expect(cleared.tavily.keyConfigured).toBe(false);
    expect(await readFile(join(homes.at(-1)!, ".everything", ".env"), "utf8")).toContain('TAVILY_API_KEY=""');
  });

  it("没有 Tavily 密钥时拒绝启用 search_web", async () => {
    const runtime = await setup();
    await expect(runtime.saveToolSettings({ getCurrentTimeEnabled: true, searchWebEnabled: true })).rejects.toThrow("必须配置 Tavily API Key");
  });

  it("探测模型连接，失败时允许显式强制保存并隐藏密钥", async () => {
    const runtime = await setup();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    try {
      fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "a" }, {}] })));
      expect((await runtime.saveAgentSettings({
        agentModel: { provider: "anthropic", model: "a", apiKey: "anthropic-secret", baseUrl: "https://api.anthropic.test" },
        smallModel: modelSettings().smallModel,
      })).models).toEqual({ agentModel: ["a"], smallModel: [] });
      fetchMock.mockResolvedValueOnce(new Response("invalid secret-123", { status: 401 }));
      await expect(runtime.saveAgentSettings({
        agentModel: { provider: "openai-compatible", model: "b", apiKey: "secret-123", baseUrl: "https://failed.example/v1" },
        smallModel: modelSettings().smallModel,
      })).rejects.toMatchObject({ canForce: true, message: "Agent Model：连接测试失败（HTTP 401）：invalid ***" });
      await runtime.saveAgentSettings({
        agentModel: { provider: "openai-compatible", model: "b", apiKey: "secret-123", baseUrl: "https://failed.example/v1" },
        smallModel: modelSettings().smallModel, force: true,
      });
      await runtime.clearModelApiKey("agentModel");
      expect((await runtime.getSettings()).agentModel.keyConfigured).toBe(false);
      expect((await runtime.getSettings()).smallModel.keyConfigured).toBe(true);
      await expect(runtime.run({ sessionId: "s", prompt: "你好" }, options())).rejects.toThrow("Agent Model API Key");
    } finally { fetchMock.mockRestore(); }
  });

  it.each([
    [{ sessionSearchWindow: 0 }, "Session Search Window"],
    [{ sessionRecallEntryTokenLimit: 1 }, "Session Recall Entry Token Limit"],
    [{ modelContextWindow: 1 }, "Model Context Window"],
    [{ maxTokens: 0 }, "单次模型输出"],
    [{ maxTokens: 131_073 }, "单次模型输出"],
    [{ maxTokens: 1.5 }, "单次模型输出"],
    [{ maxIterations: 0 }, "Agent 最大迭代"],
    [{ maxIterations: 1_001 }, "Agent 最大迭代"],
    [{ maxIterations: 1.5 }, "Agent 最大迭代"],
    [{ embeddingMinimumSimilarity: 2 }, "Minimum Similarity"],
    [{ embeddingQueryTemplate: "缺少占位符" }, "Query Template"],
    [{ embeddingDocumentTemplate: "{text}{text}" }, "Document Template"],
    [{ embeddingBaseUrl: "file:///tmp/test" }, "HTTP"],
    [{ agentModel: { ...modelSettings().agentModel, baseUrl: "file:///tmp/test" } }, "HTTP"],
    [{ retrievalMode: "dense_only" as const }, "必须完整配置"],
    [{ smallModel: { ...modelSettings().smallModel, model: "" } }, "Small Model Model 不能为空"],
    [{ agentModel: { ...modelSettings().agentModel, model: "x".repeat(201) } }, "小于 200"],
  ])("拒绝无效运行配置 %j", async (patch, error) => {
    const runtime = await setup();
    await expect(runtime.saveAgentSettings({ ...modelSettings(), ...patch })).rejects.toThrow(error);
  });
});

it("独立 Embedding 配置可重建空索引，并在更换模型后继续使用活动索引", async () => {
  const runtime = await setup();
  const input = { ...modelSettings(), retrievalMode: "hybrid" as const,
    embeddingApiKey: "embedding", embeddingBaseUrl: "https://example.com/v1", embeddingModel: "embed-a" };
  await runtime.saveAgentSettings(input);
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({ data: [{ embedding: [1, 0, 0] }] })));
  try {
    await runtime.rebuildEmbeddingIndex();
    expect((await runtime.getSettings()).embeddingIndex.ready).toBe(true);
    await runtime.saveAgentSettings({ ...input, embeddingModel: "embed-b" });
    expect((await runtime.getSettings()).embeddingIndex.ready).toBe(false);
    await runtime.prepareMemory();
  } finally { fetchMock.mockRestore(); }
});

it("聊天记忆使用 Agent Model 与当前证据，只有 gate 使用 Small Model", async () => {
  const runtime = await setup();
  await runtime.saveAgentSettings({
    agentModel: { ...modelSettings().agentModel, model: "main" },
    smallModel: { ...modelSettings().smallModel, model: "memory-small" },
  });
  const session = await runtime.createSession();
  const backgroundRelease = Promise.withResolvers<void>();
  const backgroundEvents: Array<{ kind: string; event: Record<string, unknown> }> = [];
  const unsubscribe = runtime.subscribeBackgroundEvents((kind, event) => { backgroundEvents.push({ kind, event }); });
  const removedObserver = vi.fn();
  runtime.subscribeBackgroundEvents(removedObserver)();
  let mainCalls = 0;
  create.mockImplementation(async (request) => {
    if (request.system?.includes("你是个人助理的记忆管理模型")) {
      await backgroundRelease.promise;
      expect(request.model).toBe("main");
      const payload = JSON.parse(String(request.messages[0]?.content));
      expect(payload.evidence[0].text).toBe("请记住我喜欢红茶");
      return response(JSON.stringify({ action: "create", reason: "私人理由：喜欢红茶", evidenceMessageIds: payload.candidate.evidenceMessageIds, subject: "饮品偏好", content: "喜欢红茶", category: "preference", stable: true, futureUseful: true }));
    }
    if (!Array.isArray(request.tools) || request.tools.length === 0) {
      expect(request.model).toBe("memory-small");
      return response('{"intent":"none"}');
    }
    if (Array.isArray(request.tools) && request.tools.length > 0) {
      expect(request.model).toBe("main");
      if (++mainCalls === 1) return { content: [{ type: "tool_use", id: "memory-tool", name: "manage_memory", input: { action: "submit", intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶" } }], stop_reason: "tool_use" };
      return response("已记住");
    }
    throw new Error("未预期的模型调用");
  });
  const events: Array<{ kind: string; event: Record<string, unknown> }> = [];
  await runtime.run({ sessionId: session.id, prompt: "请记住我喜欢红茶" }, { ...options(), observer: (kind, event) => { events.push({ kind, event }) } });
  const completedBeforeReply = backgroundEvents.some(({ kind }) => kind === "memory_change_completed");
  backgroundRelease.resolve();
  await runtime.memory.waitForBackgroundTasks();
  expect(completedBeforeReply).toBe(false);
  unsubscribe();
  expect(removedObserver).not.toHaveBeenCalled();
  expect(backgroundEvents.map(({ kind }) => kind)).toEqual(expect.arrayContaining([
    "memory_task_started", "memory_decision_completed", "memory_change_completed", "memory_task_completed",
  ]));
  expect(backgroundEvents[0]?.kind).toBe("memory_task_started");
  expect(backgroundEvents.at(-1)?.kind).toBe("memory_task_completed");
  expect(backgroundEvents.every(({ event }) => event.taskId && event.taskKind === "memory_write" && event.sourceRunId)).toBe(true);
  expect(JSON.stringify(backgroundEvents)).not.toContain("红茶");
  expect(runtime.memory.listSemantic()).toMatchObject([{ content: "喜欢红茶" }]);
  const memoryEvents = events.filter((item) => item.kind.startsWith("memory_") || item.kind === "tool_completed");
  expect(memoryEvents.some((item) => item.kind === "memory_change_completed")).toBe(false);
  expect(memoryEvents.find((item) => item.kind === "tool_completed")?.event.result).toMatchObject({ status: "queued", taskId: expect.any(String) });
  expect(JSON.stringify(memoryEvents)).not.toContain("红茶");
  const files = await runtime.readTraces();
  expect(files.some((file) => file.path.includes("memory_write-"))).toBe(true);
  const traces = files.flatMap((file) => file.records).filter((record) => record.type.startsWith("memory_") || record.type === "tool_completed");
  expect(traces.find((record) => record.type === "memory_model_completed")?.payload).toMatchObject({ model: "main" });
  expect(traces.find((record) => record.type === "memory_change_completed")?.payload).toMatchObject({ action: "create", reasonCode: "new_fact", targetId: expect.any(Number) });
  expect(JSON.stringify(traces)).not.toContain("红茶");
});

it("run_completed 记录供应商、三段耗时、工具失败数与上下文水位", async () => {
  const runtime = await setup();
  const session = await runtime.createSession();
  let mainCalls = 0;
  create.mockImplementation(async (request) => {
    if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
    if (++mainCalls === 1) {
      return {
        content: [
          { type: "tool_use", id: "time-call", name: "get_current_time", input: {} },
          { type: "tool_use", id: "missing-call", name: "不存在的工具", input: {} },
        ],
        stop_reason: "tool_use",
      };
    }
    return { ...response("已完成"), tokenUsage: { inputTokens: 1_234, outputTokens: 20, totalTokens: 1_254 } };
  });

  const result = await runtime.run({ sessionId: session.id, prompt: "现在几点" }, options());

  expect(result).toMatchObject({
    provider: "openai-compatible",
    model: "test",
    toolCallCount: 2,
    failedToolCallCount: 1,
    contextWindow: 262_144,
    contextSafetyTokens: 512,
    peakInputTokens: 1_234,
  });
  expect(result.availableInputTokens).toBe(result.contextWindow - result.maxTokens - result.contextSafetyTokens);
  expect(result.peakEstimatedInputTokens).toBeGreaterThan(0);
  // 三段耗时都被单独计量，且不会超过整轮墙钟时间。
  expect(result.retrievalMs + result.modelMs + result.toolMs).toBeLessThanOrEqual(result.ms);
  const completed = (await runtime.readTraces()).flatMap((file) => file.records)
    .find((record) => record.type === "run_completed");
  expect(completed?.payload).toMatchObject({
    provider: "openai-compatible",
    model: "test",
    failedToolCallCount: 1,
    peakInputTokens: 1_234,
    availableInputTokens: result.availableInputTokens,
    retrievalMs: expect.any(Number),
    modelMs: expect.any(Number),
    toolMs: expect.any(Number),
  });
});

it("记忆写入的 taskId 进入 derivedTaskIds，关联独立的后台任务 trace", async () => {
  const runtime = await setup();
  const session = await runtime.createSession();
  runtime.memory.stopBackgroundTasks();
  let mainCalls = 0;
  create.mockImplementation(async (request) => {
    if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
    if (++mainCalls === 1) {
      return {
        content: [{ type: "tool_use", id: "memory-call", name: "manage_memory", input: { action: "submit", intent: "remember", subject: "用户", attribute: "饮品偏好", content: "喜欢红茶" } }],
        stop_reason: "tool_use",
      };
    }
    return response("已记下");
  });

  const result = await runtime.run({ sessionId: session.id, prompt: "请记住我喜欢红茶" }, options());

  expect(result.derivedTaskIds).toHaveLength(1);
  expect(runtime.memory.listBackgroundTasks().map((task) => task.id)).toContain(result.derivedTaskIds[0]);
  const completed = (await runtime.readTraces()).flatMap((file) => file.records)
    .find((record) => record.type === "run_completed");
  expect(completed?.payload).toMatchObject({ derivedTaskIds: result.derivedTaskIds });
});

it("用户停止与整轮超时在 run_failed 中分别标记，不计入模型故障", async () => {
  const runtime = await setup();
  const session = await runtime.createSession();
  const controller = new AbortController();
  create.mockImplementation(async (request) => {
    if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
    controller.abort();
    return response("不会用到");
  });

  await expect(runtime.run({ sessionId: session.id, prompt: "先停下" }, { observer: () => {}, signal: controller.signal }))
    .rejects.toThrow();

  const failed = (await runtime.readTraces()).flatMap((file) => file.records)
    .find((record) => record.type === "run_failed");
  expect(failed?.payload).toMatchObject({
    cancelled: true,
    timedOut: false,
    provider: "openai-compatible",
    model: "test",
    retrievalMs: expect.any(Number),
  });
});

it("整轮超时标记 timedOut 而不是 cancelled", async () => {
  const runtime = await setup();
  const session = await runtime.createSession();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  create.mockImplementation(async (request) => {
    if (!Array.isArray(request.tools) || request.tools.length === 0) return response('{"intent":"none"}');
    await vi.advanceTimersByTimeAsync(300_001);
    return response("太慢了");
  });
  try {
    await expect(runtime.run({ sessionId: session.id, prompt: "执行超长任务" }, options())).rejects.toThrow();
    const failed = (await runtime.readTraces()).flatMap((file) => file.records)
      .find((record) => record.type === "run_failed");
    expect(failed?.payload).toMatchObject({ cancelled: false, timedOut: true });
  } finally {
    vi.useRealTimers();
  }
});

it("上下文水位与 Loop 硬限制同口径，并随会话历史增长", async () => {
  model();
  const runtime = await setup();
  const session = await runtime.createSession();

  const empty = await runtime.contextUsage(session.id);
  expect(empty.availableInputTokens).toBe(empty.contextWindow - empty.maxTokens - empty.contextSafetyTokens);
  // 空会话也有系统提示与工具 schema 的固定开销，不应显示为零占用。
  expect(empty.estimatedInputTokens).toBeGreaterThan(0);

  await runtime.run({ sessionId: session.id, prompt: "你好".repeat(500) }, options());

  const afterRun = await runtime.contextUsage(session.id);
  expect(afterRun.estimatedInputTokens).toBeGreaterThan(empty.estimatedInputTokens);
});

it("长会话自动 compact 后水位下降，检查点、聊天标记与脱敏事件同时持久化", async () => {
  const runtime = await setup();
  await runtime.saveAgentSettings({ ...modelSettings(), modelContextWindow: 32768, maxTokens: 2048 });
  const session = await runtime.createSession();
  runtime.memory.startRun(session.id, "old-run", "历史任务".repeat(6000));
  await runtime.memory.completeRun(session.id, "old-run", [{ role: "assistant", content: [{ type: "text", text: "已经完成" }] }]);
  create.mockImplementation(async (request) => {
    if (request.model === "small-test") return response('{"intent":"none"}');
    if (Array.isArray(request.tools) && request.tools.length === 0) return response("历史任务已完成，保持中文回答。");
    expect(request.messages[0]).toMatchObject({ contextSummary: true });
    expect(request.messages.at(-1)).toEqual({ role: "user", content: "请继续" });
    return response("完成");
  });
  const before = await runtime.contextUsage(session.id);
  const seen: string[] = [];
  await runtime.run({ sessionId: session.id, prompt: "请继续" }, { ...options(), observer: (kind) => { seen.push(kind); } });
  expect(seen).toContain("compact_completed");
  expect((await runtime.contextUsage(session.id)).estimatedInputTokens).toBeLessThan(before.estimatedInputTokens);
  expect(runtime.memory.getChatLog(session.id)).toHaveLength(4);
  expect(runtime.memory.getChatLog(session.id)[2]?.compactions).toHaveLength(1);
  const records = (await runtime.readTraces()).flatMap((file) => file.records).filter((record) => record.type.startsWith("compact_"));
  expect(records.map((record) => record.type)).toEqual(["compact_started", "compact_model_started", "compact_model_completed", "compact_completed"]);
  expect(records.at(-1)).toMatchObject({ sessionId: session.id, payload: { targetReached: true } });
  expect(JSON.stringify(records)).not.toContain("历史任务已完成");
});
