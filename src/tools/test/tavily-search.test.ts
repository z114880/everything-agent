import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalToolRegistry } from "../tool-registry.ts";

afterEach(() => vi.restoreAllMocks());

describe("Tavily 网页搜索工具", () => {
  const context = { signal: undefined, deadline: null, iteration: 1, toolUseId: "tool-1" };

  it("只在已启用且已配置密钥时注册 search_web，并返回精简结果", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      results: [{ title: "示例", url: "https://example.com", content: "摘要", score: 0.9, raw_content: "不得返回" }],
      response_time: "0.42", request_id: "request-1",
    })));
    const registry = new LocalToolRegistry(undefined, undefined, undefined, undefined, {
      searchWebEnabled: true, tavilyApiKey: "tvly-secret",
    });

    expect((registry.schemas() as Array<{ name: string }>).map((item) => item.name)).toEqual(["get_current_time", "search_web"]);
    await expect(registry.execute("search_web", { query: "最新消息", max_results: 3 }, async () => {}, context)).resolves.toEqual({
      query: "最新消息", results: [{ title: "示例", url: "https://example.com", content: "摘要", score: 0.9 }],
      responseTime: "0.42", requestId: "request-1",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/search", expect.objectContaining({
      method: "POST", headers: expect.objectContaining({ Authorization: "Bearer tvly-secret" }),
      body: JSON.stringify({ query: "最新消息", search_depth: "basic", max_results: 3, include_answer: false, include_raw_content: false }),
    }));
  });

  it("拒绝越界参数，并且停用工具后不再向模型公开或执行", async () => {
    const disabled = new LocalToolRegistry(undefined, undefined, undefined, undefined, {
      getCurrentTimeEnabled: false, searchWebEnabled: false, tavilyApiKey: "tvly-secret",
    });
    expect(disabled.schemas()).toEqual([]);
    expect(() => disabled.execute("get_current_time", {}, async () => {}, context)).toThrow("工具未注册");
    expect(() => disabled.execute("search_web", { query: "消息" }, async () => {}, context)).toThrow("工具未注册");

    const enabled = new LocalToolRegistry(undefined, undefined, undefined, undefined, { searchWebEnabled: true, tavilyApiKey: "key" });
    await expect(enabled.execute("search_web", { query: " ", max_results: 99 }, async () => {}, context)).rejects.toThrow("query");
  });

  it("外部错误不泄露 API Key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("secret", { status: 401 }));
    const registry = new LocalToolRegistry(undefined, undefined, undefined, undefined, { searchWebEnabled: true, tavilyApiKey: "private-key" });
    await expect(registry.execute("search_web", { query: "test" }, async () => {}, context)).rejects.toThrow("HTTP 401");
  });
});
