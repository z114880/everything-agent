import { afterEach, expect, it, vi } from "vitest";
import { subscribeBackgroundEvents } from "../src/agent-api";

afterEach(() => vi.unstubAllGlobals());

it("后台订阅持续接收多个任务事件并在离开页面时关闭连接", () => {
  let source!: FakeEventSource;
  class FakeEventSource {
    onmessage: ((message: { data: string }) => void) | null = null;
    close = vi.fn();
    constructor(readonly url: string) { source = this; }
  }
  vi.stubGlobal("EventSource", FakeEventSource);
  const observer = vi.fn();
  const unsubscribe = subscribeBackgroundEvents(observer);
  expect(source.url).toBe("/api/local-agent/background-events");
  for (const kind of ["memory_task_started", "memory_task_completed", "memory_task_started"]) {
    source.onmessage?.({ data: JSON.stringify({ kind, event: { taskId: "task-1" } }) });
  }
  expect(observer).toHaveBeenCalledTimes(3);
  expect(source.close).not.toHaveBeenCalled();
  unsubscribe();
  expect(source.close).toHaveBeenCalledOnce();
});
