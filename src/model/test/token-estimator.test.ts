import { describe, expect, it } from "vitest";
import type { ModelRequest } from "../../agent-loop/agent-loop.ts";
import { estimateRequestTokens, estimateTextTokens, RoughTokenEstimator } from "../token-estimator.ts";

describe("Token 估算器", () => {
  it("分别估算 ASCII、CJK 与其他非 ASCII 文本", () => {
    expect(estimateTextTokens("abcd")).toBe(1);
    expect(estimateTextTokens("abcde")).toBe(2);
    expect(estimateTextTokens("中文")).toBe(2);
    expect(estimateTextTokens("é")).toBe(1);
    expect(estimateTextTokens("😀")).toBe(1);
    expect(estimateTextTokens("中文abcd")).toBe(3);
    expect(estimateTextTokens("")).toBe(0);
  });

  it("请求估算覆盖 System Prompt、消息与工具 schema", () => {
    const request: ModelRequest = {
      model: "test",
      system: "系统",
      messages: [{ role: "user", content: "你好" }],
      tools: [{ name: "clock", description: "时间", input_schema: { type: "object" } }],
      max_tokens: 2_048,
      signal: undefined,
    };
    const expected = estimateTextTokens(request.system)
      + estimateTextTokens(JSON.stringify(request.messages))
      + estimateTextTokens(JSON.stringify(request.tools));
    expect(estimateRequestTokens(request)).toBe(expected);
    expect(new RoughTokenEstimator().estimateRequest(request)).toBe(expected);
  });
});
