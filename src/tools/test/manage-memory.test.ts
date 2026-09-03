import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryRuntime } from "../../memory/index.js";
import { ManageMemoryTool } from "../manage-memory.js";
import { LocalToolRegistry } from "../tool-registry.js";

const memories: MemoryRuntime[] = [];
afterEach(() => memories.splice(0).forEach((memory) => memory.close()));

describe("manage_memory", () => {
  it("允许创建 semantic，但拒绝创建 episodic", async () => {
    const tool = new ManageMemoryTool(await memory());
    expect(tool.execute({ action: "create", kind: "semantic", subject: "用户", content: "喜欢茶" }))
      .toMatchObject({ subject: "用户", content: "喜欢茶" });
    expect(() => tool.execute({ action: "create", kind: "episodic", content: "事件" }))
      .toThrow("只能由 Session consolidation");
  });

  it("删除前必须使用同一目标的确认令牌", async () => {
    const runtime = await memory();
    const item = runtime.createSemantic("用户", "喜欢茶");
    const tool = new ManageMemoryTool(runtime);
    const pending = tool.execute({ action: "delete", kind: "semantic", id: item.id }) as { confirmationId: string };
    expect(runtime.listSemantic()).toHaveLength(1);
    expect(tool.execute({ action: "delete", kind: "semantic", id: item.id, confirmationId: pending.confirmationId }))
      .toEqual({ deleted: true, kind: "semantic", id: item.id });
    expect(runtime.listSemantic()).toEqual([]);
  });

  it("支持搜索和更新 semantic，并拒绝工具更新 episodic", async () => {
    const runtime = await memory();
    const semantic = runtime.createSemantic("用户", "喜欢茶");
    runtime.createEpisodic("一起讨论过喝茶", "2026-09-03T10:20:30+08:00");
    const tool = new ManageMemoryTool(runtime);

    expect(tool.execute({ action: "search", kind: "semantic", query: "喜欢茶" })).toHaveLength(1);
    expect(tool.execute({ action: "search", kind: "episodic", query: "讨论喝茶" })).toHaveLength(1);
    expect(tool.execute({ action: "update", kind: "semantic", id: semantic.id, subject: "用户", content: "喜欢绿茶" }))
      .toMatchObject({ content: "喜欢绿茶" });
    expect(() => tool.execute({ action: "update", kind: "episodic", id: 1, content: "修改" }))
      .toThrow("不能由普通工具调用修改");
  });

  it("拒绝无效参数、操作和不匹配的删除确认", async () => {
    const runtime = await memory();
    const item = runtime.createSemantic("用户", "喜欢茶");
    const tool = new ManageMemoryTool(runtime);

    expect(() => tool.execute(null)).toThrow("参数必须是对象");
    expect(() => tool.execute({ action: "search", kind: "unknown", query: "茶" })).toThrow("kind 必须是");
    expect(() => tool.execute({ action: "unknown", kind: "semantic" })).toThrow("action 无效");
    expect(() => tool.execute({ action: "update", kind: "semantic", id: 0, subject: "用户", content: "茶" })).toThrow("正整数");
    expect(() => tool.execute({ action: "delete", kind: "semantic", id: 999 })).toThrow("待删除的记忆不存在");
    expect(() => tool.execute({ action: "delete", kind: "semantic", id: item.id, confirmationId: "wrong" }))
      .toThrow("删除确认无效或已过期");
  });

  it("本地工具注册表按依赖开放工具并校验执行", async () => {
    const runtime = await memory();
    const plain = new LocalToolRegistry();
    const withMemory = new LocalToolRegistry(runtime);
    const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "t1" };

    expect(plain.schemas()).toHaveLength(1);
    expect(withMemory.schemas()).toHaveLength(2);
    expect(plain.execute("get_current_time", {}, async () => {}, context)).toMatchObject({ timeZone: expect.any(String) });
    expect(() => plain.execute("get_current_time", { unexpected: true }, async () => {}, context)).toThrow("不接受参数");
    expect(() => plain.execute("unknown", {}, async () => {}, context)).toThrow("工具未注册");
    const controller = new AbortController();
    controller.abort(new Error("已取消"));
    expect(() => plain.execute("get_current_time", {}, async () => {}, { ...context, signal: controller.signal })).toThrow("已取消");
  });
});

async function memory(): Promise<MemoryRuntime> {
  const runtime = new MemoryRuntime(await mkdtemp(join(tmpdir(), "everything-manage-memory-")));
  memories.push(runtime);
  return runtime;
}
