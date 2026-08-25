import { describe, expect, it, vi } from "vitest";

import {
  END,
  START,
  Graph,
  StateCollisionError,
  loop,
  node,
  runGraph,
} from "../src/index.js";

describe("loop", () => {
  it("顺序执行节点并合并状态", async () => {
    const graph = new Graph("basic")
      .addNode(node("double", (state) => ({ doubled: state.value * 2 })))
      .addNode(node("format", (state) => ({ text: String(state.doubled) })))
      .addEdge(START, "double")
      .addEdge("double", "format")
      .addEdge("format", END);

    const result = await runGraph(graph, { value: 3 });

    expect(result).toMatchObject({
      state: { value: 3, doubled: 6, text: "6" },
      path: ["double", "format"],
      steps: 2,
      error: null,
    });
  });

  it("同一波次并发执行，并在所有依赖完成后汇合", async () => {
    let releaseSlow;
    const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
    const started = [];

    const graph = new Graph("parallel")
      .addNode(node("slow", async (state) => {
        started.push("slow");
        await slowGate;
        return { left: state.seed + 1 };
      }))
      .addNode(node("fast", (state) => {
        started.push("fast");
        releaseSlow();
        return { right: state.seed + 2 };
      }))
      .addNode(node("join", (state) => ({ total: state.left + state.right })))
      .addEdge(START, "slow")
      .addEdge(START, "fast")
      .addEdge("slow", "join")
      .addEdge("fast", "join")
      .addEdge("join", END);

    const result = await loop(graph, { seed: 10 });

    expect(started).toEqual(["slow", "fast"]);
    expect(result.path).toEqual(["slow", "fast", "join"]);
    expect(result.state.total).toBe(23);
  });

  it("代码路由只执行命中的分支", async () => {
    const graph = new Graph("router")
      .addNode(node("classify", (state) => ({ route: state.short ? "quick" : "full" })))
      .addNode(node("quick", () => ({ reply: "quick" })))
      .addNode(node("full", () => ({ reply: "full" })))
      .addEdge(START, "classify")
      .addRouter("classify", (state) => state.route, { quick: "quick", full: "full" })
      .addEdge("quick", END)
      .addEdge("full", END);

    const result = await loop(graph, { short: true });

    expect(result.path).toEqual(["classify", "quick"]);
    expect(result.state.reply).toBe("quick");
  });

  it("节点异常写入状态，并通过 onError 跳转到恢复节点", async () => {
    const graph = new Graph("recover")
      .addNode(node("broken", () => {
        throw new Error("boom");
      }, { onError: "recover" }))
      .addNode(node("recover", () => ({ recovered: true })))
      .addEdge(START, "broken")
      .addEdge("recover", END);

    const result = await loop(graph);

    expect(result.state.errors.broken).toContain("boom");
    expect(result.state.recovered).toBe(true);
    expect(result.path).toEqual(["broken", "recover"]);
  });

  it("没有恢复目标的节点异常会让图自然结束", async () => {
    const graph = new Graph("drain")
      .addNode(node("broken", () => { throw new Error("stop"); }))
      .addNode(node("unreached", () => ({ reached: true })))
      .addEdge(START, "broken")
      .addEdge("broken", "unreached");

    const result = await loop(graph);

    expect(result.path).toEqual(["broken"]);
    expect(result.state.reached).toBeUndefined();
    expect(result.error).toContain("stop");
  });

  it("路由异常或未知标签作为状态错误返回", async () => {
    const throwing = new Graph("throwing-router")
      .addNode(node("gate", () => ({})))
      .addEdge(START, "gate")
      .addRouter("gate", () => { throw new Error("bad route"); }, { done: END });
    const unknown = new Graph("unknown-router")
      .addNode(node("gate", () => ({})))
      .addEdge(START, "gate")
      .addRouter("gate", () => "toString", { done: END });

    const throwingResult = await loop(throwing);
    const unknownResult = await loop(unknown);

    expect(throwingResult.state.errors.gate).toContain("bad route");
    expect(unknownResult.state.errors.gate).toContain("未知标签");
  });

  it("并行节点写入同一状态键时拒绝静默覆盖", async () => {
    const graph = new Graph("collision")
      .addNode(node("one", () => ({ answer: 1 })))
      .addNode(node("two", () => ({ answer: 2 })))
      .addEdge(START, "one")
      .addEdge(START, "two");

    await expect(loop(graph)).rejects.toBeInstanceOf(StateCollisionError);
  });

  it("拒绝节点返回非对象增量", async () => {
    const graph = new Graph("invalid-update")
      .addNode(node("invalid", () => []))
      .addEdge(START, "invalid");

    await expect(loop(graph)).rejects.toThrow("必须返回普通对象");
  });

  it("maxSteps 和 maxVisits 分别限制全局步数与节点访问次数", async () => {
    const createCycle = (maxVisits) => new Graph("bounded")
      .addNode(node("again", (state) => ({ count: (state.count ?? 0) + 1 }), { maxVisits }))
      .addEdge(START, "again")
      .addRouter("again", () => "again", { again: "again" });

    const stepLimited = await loop(createCycle(10), {}, { maxSteps: 3 });
    const visitLimited = await loop(createCycle(2));

    expect(stepLimited.state.count).toBe(3);
    expect(stepLimited.state.errors.engine).toContain("maxSteps=3");
    expect(visitLimited.state.count).toBe(2);
    expect(visitLimited.state.errors.again).toContain("maxVisits=2");
  });

  it("observer 按生命周期收到事件，节点可发送自定义事件", async () => {
    const observer = vi.fn();
    const graph = new Graph("events")
      .addNode(node("work", async (_state, context) => {
        await context.emit("progress", { percent: 100 });
        return { done: true };
      }))
      .addEdge(START, "work")
      .addEdge("work", END);

    await loop(graph, {}, { observer });

    expect(observer.mock.calls.map(([kind]) => kind)).toEqual([
      "loop_start",
      "node_start",
      "progress",
      "node_end",
      "loop_end",
    ]);
    expect(observer).toHaveBeenCalledWith("progress", { percent: 100, node: "work" });
  });

  it("空图正常结束，并验证 loop 选项", async () => {
    await expect(loop(new Graph("empty"))).resolves.toMatchObject({
      state: {},
      path: [],
      steps: 0,
      error: null,
    });
    await expect(loop(new Graph("bad-steps"), {}, { maxSteps: 0 }))
      .rejects.toThrow("maxSteps 必须是正整数");
    await expect(loop(new Graph("bad-observer"), {}, { observer: true }))
      .rejects.toThrow("observer 必须是函数");
  });
});
