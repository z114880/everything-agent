import { describe, expect, it } from "vitest";

import { Node, node } from "../src/index.js";

describe("Node", () => {
  it("通过 node 工厂创建带默认选项的节点", async () => {
    const value = node("prepare", (state) => ({ output: state.input + 1 }));

    expect(value).toBeInstanceOf(Node);
    expect(value).toMatchObject({
      name: "prepare",
      kind: "fn",
      maxVisits: 1,
      onError: null,
    });
    await expect(value.run({ input: 1 }, {})).resolves.toEqual({ output: 2 });
  });

  it("支持异步 handler，并将空返回值转换为空增量", async () => {
    const value = node("empty", async () => undefined, {
      kind: "tool",
      maxVisits: 2,
      onError: "recover",
    });

    await expect(value.run({}, {})).resolves.toEqual({});
    expect(value).toMatchObject({ kind: "tool", maxVisits: 2, onError: "recover" });
  });

  it.each([
    ["空名称", () => node("", () => ({})), "节点名称必须是非空字符串"],
    ["非函数 handler", () => node("bad", null), "handler 必须是函数"],
    ["未知 kind", () => node("bad", () => ({}), { kind: "network" }), "kind 不受支持"],
    ["非正数 maxVisits", () => node("bad", () => ({}), { maxVisits: 0 }), "maxVisits 必须是正整数"],
  ])("拒绝%s", (_case, create, message) => {
    expect(create).toThrow(message);
  });
});
