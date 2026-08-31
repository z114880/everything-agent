import { describe, expect, it } from "vitest";

import { State, StateCollisionError } from "../src/index.js";

describe("State", () => {
  it("保存初始状态，并通过副本隔离顶层属性赋值", () => {
    const initial = { count: 1 };
    const state = new State(initial);

    initial.count = 2;
    const snapshot = state.snapshot();
    (snapshot as { count: number }).count = 3;

    expect(state.value()).toEqual({ count: 1 });
  });

  it("按 wave 合并互不冲突的节点增量，并忽略内部键", () => {
    const state = new State({ input: "hello" });

    state.mergeWave([
      { node: "left", update: { left: 1, _trace: "不应保存" } },
      { node: "right", update: { right: 2 } },
    ]);

    expect(state.value()).toEqual({ input: "hello", left: 1, right: 2 });
  });

  it("拒绝同一 wave 的节点覆盖相同状态键", () => {
    const state = new State();

    expect(() => state.mergeWave([
      { node: "first", update: { answer: 1 } },
      { node: "second", update: { answer: 2 } },
    ])).toThrow(StateCollisionError);
  });

  it("拒绝非对象初始状态和节点增量", () => {
    expect(() => new State([] as never)).toThrow("初始状态必须是普通对象");
    expect(() => new State().mergeWave([
      { node: "invalid", update: null as never },
    ])).toThrow('节点 "invalid" 必须返回普通对象');
  });

  it("将 Error 和普通值统一记录为可序列化错误信息", () => {
    const state = new State({ errors: "无效的旧值" });

    state.recordError("node-a", new Error("boom"));
    state.recordError("node-b", "timeout");

    expect(state.value().errors).toEqual({
      "node-a": "Error: boom",
      "node-b": "timeout",
    });
  });
});
