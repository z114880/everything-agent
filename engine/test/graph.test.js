import { describe, expect, it } from "vitest";

import { END, START, Graph, describe as describeGraph, node } from "../src/index.js";

describe("Graph", () => {
  it("通过链式接口声明节点和边", () => {
    const graph = new Graph("pipeline");

    expect(graph.addNode(node("run", () => ({})))).toBe(graph);
    expect(graph.addEdge(START, "run")).toBe(graph);
    expect(graph.addEdge("run", END)).toBe(graph);
  });

  it("拒绝无效、保留或重复节点", () => {
    expect(() => new Graph("")).toThrow("图名称必须是非空字符串");

    const graph = new Graph("invalid-node");
    expect(() => graph.addNode({ name: "plain-object" })).toThrow("只接受 Node 实例");
    expect(() => graph.addNode(node(START, () => ({})))).toThrow("保留名称");

    graph.addNode(node("same", () => ({})));
    expect(() => graph.addNode(node("same", () => ({})))).toThrow("已存在");
  });

  it("在声明阶段拒绝无效或重复的边", () => {
    const graph = new Graph("invalid-edge").addNode(node("run", () => ({})));

    expect(() => graph.addEdge(START, "missing")).toThrow('未知节点 "missing"');
    expect(() => graph.addEdge(END, "run")).toThrow("END 不能作为边的起点");
    expect(() => graph.addEdge("run", START)).toThrow('未知节点 "START"');

    graph.addEdge(START, "run");
    expect(() => graph.addEdge(START, "run")).toThrow("已存在");
  });

  it("验证条件路由的来源、函数和目标", () => {
    const graph = new Graph("invalid-router").addNode(node("gate", () => ({})));

    expect(() => graph.addRouter("missing", () => "done", { done: END }))
      .toThrow("未知路由节点");
    expect(() => graph.addRouter("gate", null, { done: END })).toThrow("route 必须是函数");
    expect(() => graph.addRouter("gate", () => "done", [])).toThrow("targets 必须是对象");
    expect(() => graph.addRouter("gate", () => "done", {})).toThrow("路由目标不能为空");
    expect(() => graph.addRouter("gate", () => "done", { done: "missing" }))
      .toThrow('未知节点 "missing"');
  });

  it("describe 从真实图生成拓扑，并去重同一目标", () => {
    const graph = new Graph("topology")
      .addNode(node("gate", () => ({}), { kind: "llm", maxVisits: 2 }))
      .addNode(node("done", () => ({})))
      .addEdge(START, "gate")
      .addRouter("gate", () => "ok", { ok: "done", retry: "done", stop: END });

    const expected = {
      name: "topology",
      nodes: [
        { name: "gate", kind: "llm", maxVisits: 2 },
        { name: "done", kind: "fn", maxVisits: 1 },
      ],
      edges: [
        { source: START, target: "gate", conditional: false },
        { source: "gate", target: "done", conditional: true },
        { source: "gate", target: END, conditional: true },
      ],
    };

    expect(graph.describe()).toEqual(expected);
    expect(describeGraph(graph)).toEqual(expected);
    expect(JSON.parse(JSON.stringify(graph.describe()))).toEqual(expected);
  });
});
