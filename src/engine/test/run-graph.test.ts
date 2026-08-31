import { describe, expect, it, vi } from "vitest";
import * as engine from "../src/index.js";

import {
  END,
  START,
  Graph,
  StateCollisionError,
  node,
  runGraph,
} from "../src/index.js";

describe("runGraph", () => {
  it("作为唯一的 Graph 执行入口公开", () => {
    expect(engine.runGraph).toBeTypeOf("function");
    expect(engine).not.toHaveProperty("runAgentLoop");
  });

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

  it("同一 wave 并发执行，并在所有依赖完成后汇合", async () => {
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const started: string[] = [];

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

    const result = await runGraph(graph, { seed: 10 });

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

    const result = await runGraph(graph, { short: true });

    expect(result.path).toEqual(["classify", "quick"]);
    expect(result.state.reply).toBe("quick");
  });

  it("条件分支未命中的路径会跳过，并允许后续节点汇合", async () => {
    const graph = new Graph("conditional-join")
      .addNode(node("classify", () => ({ route: "quick" })))
      .addNode(node("quick", () => ({ quickResult: true })))
      .addNode(node("full", () => ({ fullResult: true })))
      .addNode(node("fullDetail", () => ({ detail: true })))
      .addNode(node("reply", (state) => ({ reply: state.quickResult ? "quick" : "full" })))
      .addEdge(START, "classify")
      .addRouter("classify", (state) => state.route, { quick: "quick", full: "full" })
      .addEdge("quick", "reply")
      .addEdge("full", "fullDetail")
      .addEdge("fullDetail", "reply")
      .addEdge("reply", END);

    const result = await runGraph(graph);

    expect(result.path).toEqual(["classify", "quick", "reply"]);
    expect(result.state).toMatchObject({ quickResult: true, reply: "quick" });
    expect(result.state.fullResult).toBeUndefined();
    expect(result.state.detail).toBeUndefined();
    expect(result.status).toBe("completed");
  });

  it("wave_start 只报告当前 wave 实际激活的入边", async () => {
    const activatedEdges: unknown[] = [];
    const graph = new Graph("observable-branch-join")
      .addNode(node("classify", () => ({ route: "normal" })))
      .addNode(node("context", () => ({ context: true })))
      .addNode(node("urgent", () => ({ advice: "urgent" })))
      .addNode(node("normal", () => ({ advice: "normal" })))
      .addNode(node("reply", (state) => ({ reply: `${state.context}:${state.advice}` })))
      .addEdge(START, "classify")
      .addEdge(START, "context")
      .addRouter("classify", (state) => state.route, { urgent: "urgent", normal: "normal" })
      .addEdge("urgent", "reply")
      .addEdge("normal", "reply")
      .addEdge("context", "reply")
      .addEdge("reply", END);

    await runGraph(graph, {}, {
      observer(kind, event) {
        if (kind === "wave_start" && event.wave === 3) {
          activatedEdges.push(event.activatedEdges);
        }
      },
    });

    expect(activatedEdges).toEqual([[
      { source: "normal", target: "reply", conditional: false },
      { source: "context", target: "reply", conditional: false },
    ]]);
  });

  it("并行上游失败时不会把失败分支当作跳过并运行汇合节点", async () => {
    const graph = new Graph("failed-join")
      .addNode(node("broken", () => { throw new Error("boom"); }))
      .addNode(node("healthy", () => ({ healthy: true })))
      .addNode(node("join", () => ({ joined: true })))
      .addEdge(START, "broken")
      .addEdge(START, "healthy")
      .addEdge("broken", "join")
      .addEdge("healthy", "join");

    const result = await runGraph(graph);

    expect(result.path).toEqual(["broken", "healthy"]);
    expect(result.state.joined).toBeUndefined();
    expect(result.status).toBe("failed");
  });

  it("没有可运行节点但仍有部分激活依赖时返回 stalled", async () => {
    const observer = vi.fn();
    const graph = new Graph("stalled")
      .addNode(node("active", () => ({ active: true })))
      .addNode(node("orphan", () => ({ orphan: true })))
      .addNode(node("join", () => ({ joined: true })))
      .addEdge(START, "active")
      .addEdge("active", "join")
      .addEdge("orphan", "join");

    const result = await runGraph(graph, {}, { observer });

    expect(result.status).toBe("stalled");
    expect(result.path).toEqual(["active"]);
    expect(result.blockedNodes).toEqual([
      { node: "join", waitingFor: ["orphan"] },
    ]);
    expect(result.error).toContain("运行停滞");
    expect(observer.mock.calls.map(([kind]) => kind)).toEqual([
      "graph_start",
      "wave_start",
      "node_start",
      "node_end",
      "graph_stalled",
      "graph_end",
    ]);
    expect(observer).toHaveBeenCalledWith("graph_end", expect.objectContaining({
      status: "stalled",
      blockedNodes: [{ node: "join", waitingFor: ["orphan"] }],
    }));
  });

  it("节点异常写入状态，并通过 onError 跳转到恢复节点", async () => {
    const graph = new Graph("recover")
      .addNode(node("broken", () => {
        throw new Error("boom");
      }, { onError: "recover" }))
      .addNode(node("recover", () => ({ recovered: true })))
      .addEdge(START, "broken")
      .addEdge("recover", END);

    const result = await runGraph(graph);

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

    const result = await runGraph(graph);

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

    const throwingResult = await runGraph(throwing);
    const unknownResult = await runGraph(unknown);

    expect(throwingResult.state.errors.gate).toContain("bad route");
    expect(unknownResult.state.errors.gate).toContain("未知标签");
  });

  it("并行节点写入同一状态键时拒绝静默覆盖", async () => {
    const graph = new Graph("collision")
      .addNode(node("one", () => ({ answer: 1 })))
      .addNode(node("two", () => ({ answer: 2 })))
      .addEdge(START, "one")
      .addEdge(START, "two");

    await expect(runGraph(graph)).rejects.toBeInstanceOf(StateCollisionError);
  });

  it("拒绝节点返回非对象增量", async () => {
    const graph = new Graph("invalid-update")
      .addNode(node("invalid", () => [] as never))
      .addEdge(START, "invalid");

    await expect(runGraph(graph)).rejects.toThrow("必须返回普通对象");
  });

  it("maxSteps 和 maxVisits 分别限制全局步数与节点访问次数", async () => {
    const createCycle = (maxVisits: number) => new Graph("bounded")
      .addNode(node("again", (state) => ({ count: (state.count ?? 0) + 1 }), { maxVisits }))
      .addEdge(START, "again")
      .addRouter("again", () => "again", { again: "again" });

    const stepLimited = await runGraph(createCycle(10), {}, { maxSteps: 3 });
    const visitLimited = await runGraph(createCycle(2));

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

    await runGraph(graph, {}, { observer });

    expect(observer.mock.calls.map(([kind]) => kind)).toEqual([
      "graph_start",
      "wave_start",
      "node_start",
      "progress",
      "node_end",
      "graph_end",
    ]);
    expect(observer).toHaveBeenCalledWith("progress", { percent: 100, node: "work" });
    expect(observer).toHaveBeenCalledWith("graph_start", {
      graph: "events",
      nodes: ["work"],
    });
    expect(observer).toHaveBeenCalledWith("wave_start", {
      graph: "events",
      wave: 1,
      nodes: ["work"],
      activatedEdges: [
        { source: START, target: "work", conditional: false },
      ],
    });
    expect(observer).toHaveBeenCalledWith("node_start", expect.objectContaining({
      node: "work",
      wave: 1,
    }));
    expect(observer).toHaveBeenCalledWith("graph_end", expect.objectContaining({
      graph: "events",
      steps: 1,
      path: ["work"],
      error: null,
    }));
  });

  it("空图正常结束，并验证 runGraph 选项", async () => {
    await expect(runGraph(new Graph("empty"))).resolves.toMatchObject({
      state: {},
      path: [],
      steps: 0,
      error: null,
    });
    await expect(runGraph(new Graph("bad-steps"), {}, { maxSteps: 0 }))
      .rejects.toThrow("maxSteps 必须是正整数");
    await expect(runGraph(new Graph("bad-observer"), {}, { observer: true as never }))
      .rejects.toThrow("observer 必须是函数");
  });
});
