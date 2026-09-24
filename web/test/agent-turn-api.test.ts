import { afterEach, expect, it, vi } from "vitest";
import { loadTrace, runAgent } from "../src/agent-api";

afterEach(() => vi.unstubAllGlobals());

it("聊天请求发送到回合入口，流式事件和结果保留同一个 turnId", async () => {
  const result = { turnId: "turn-1", reply: "已完成" };
  const fetchMock = vi.fn().mockResolvedValue(new Response([
    JSON.stringify({ type: "event", kind: "reply", event: { turnId: "turn-1", sessionId: "session-1", text: "已完成" } }),
    JSON.stringify({ type: "result", result }),
  ].join("\n")));
  vi.stubGlobal("fetch", fetchMock);
  const observer = vi.fn();
  const signal = new AbortController().signal;
  await expect(runAgent("你好", "session-1", observer, signal)).resolves.toEqual(result);
  expect(fetchMock).toHaveBeenCalledWith("/api/local-agent/turn", expect.objectContaining({
    method: "POST", body: JSON.stringify({ prompt: "你好", sessionId: "session-1" }), signal,
  }));
  expect(observer).toHaveBeenCalledWith("reply", expect.objectContaining({ turnId: "turn-1", sessionId: "session-1" }));
});

it("轨迹详情通过 traceId 定位，支持聊天与后台任务共用入口", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ files: [] })));
  vi.stubGlobal("fetch", fetchMock);
  await loadTrace("task/整理");
  expect(fetchMock).toHaveBeenCalledWith(`/api/local-agent/traces?traceId=${encodeURIComponent("task/整理")}`, undefined);
});
