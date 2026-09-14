// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../src/App";

const api = vi.hoisted(() => ({ loadAgent: vi.fn(), loadContextUsage: vi.fn(), memoryAction: vi.fn(), runAgent: vi.fn(), subscribeBackgroundEvents: vi.fn() }));
vi.mock("../src/agent-api", () => api);
vi.mock("../src/pages/agent/AgentHarnessCanvas", () => ({ AgentHarnessCanvas: ({ nodeStates, activeEdges }: { nodeStates: Record<string, string>; activeEdges: Set<string> }) => (
  <>
    <output data-testid="graph-states">{JSON.stringify(nodeStates)}</output>
    <output data-testid="graph-edges">{JSON.stringify([...activeEdges])}</output>
  </>
) }));
vi.mock("../src/pages/config/ConfigPage", () => ({ ConfigPage: () => <div>配置页面</div> }));

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const sessions = [{ id: "session-1", title: "当前会话", messageCount: 0 }];
  api.loadAgent.mockResolvedValue({ workflow: { nodes: [], edges: [] }, settings: { agentModel: { keyConfigured: true }, smallModel: { keyConfigured: true } }, sessions, semanticCount: 0 });
  api.memoryAction.mockImplementation(async ({ action }) => action === "select_session" ? { messages: [], sessions } : null);
  api.loadContextUsage.mockResolvedValue(null);
  api.subscribeBackgroundEvents.mockReturnValue(vi.fn());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
async function enterMessage(text: string) {
  const input = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("运行时切换页面再返回，保留流式回复和停止控制", async () => {
  api.runAgent.mockImplementation((_prompt, _session, _onEvent, signal: AbortSignal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("已停止")), { once: true });
  }));
  await enterMessage("继续执行任务");
  await click("发送");
  expect(api.runAgent).toHaveBeenCalledTimes(1);
  const [, , onEvent, signal] = api.runAgent.mock.calls[0]!;
  await click("配置");
  expect(container.querySelector("textarea")!.closest("main")!.hidden).toBe(true);
  expect(api.subscribeBackgroundEvents.mock.results[0]!.value).not.toHaveBeenCalled();
  await act(async () => onEvent("text", { delta: "后台回复" }));
  await click("Agent");
  expect(container.textContent).toContain("继续执行任务");
  expect(container.textContent).toContain("后台回复");
  expect(container.querySelector("textarea")!.closest("main")!.hidden).toBe(false);
  expect(container.querySelector("textarea")!.disabled).toBe(true);
  expect(signal.aborted).toBe(false);
  await click("停止");
  expect(signal.aborted).toBe(true);
  expect(container.textContent).toContain("本轮运行已停止");
});

it("切换页面再返回保留输入草稿和会话", async () => {
  await enterMessage("未发送的草稿");
  await click("配置");
  await click("Agent");
  expect(container.querySelector("textarea")!.value).toBe("未发送的草稿");
  expect(container.textContent).toContain("当前会话");
});

it("离开页面期间运行完成，返回后可发送下一轮", async () => {
  vi.useFakeTimers();
  try {
    let complete!: (value: unknown) => void;
    const completion = { promise: new Promise<unknown>((resolve) => { complete = resolve; }) };
    api.runAgent.mockReturnValueOnce(completion.promise);
    await enterMessage("后台执行");
    await click("发送");
    await click("配置");
    api.memoryAction.mockImplementation(async ({ action }) => action === "select_session" ? {
      sessions: [{ id: "session-1", title: "当前会话", messageCount: 2 }],
      messages: [
        { runId: "run-1", kind: "user_message", content: "后台执行" },
        { runId: "run-1", kind: "assistant_message", content: "执行完成" },
      ],
    } : null);
    await act(async () => {
      complete({ reply: "执行完成", iterations: 1, stopReason: "completed", toolCallCount: 0, ms: 10 });
      await vi.advanceTimersByTimeAsync(1000);
    });
    await click("Agent");
    expect(container.textContent).toContain("执行完成");
    expect(container.querySelector("textarea")!.disabled).toBe(false);
    await enterMessage("下一轮任务");
    await click("发送");
    expect(api.runAgent).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});

it("返回时刷新模型配置并保留草稿", async () => {
  await enterMessage("配置后再发送");
  await click("配置");
  const bootstrap = await api.loadAgent();
  api.loadAgent.mockResolvedValue({ ...bootstrap, settings: { ...bootstrap.settings, agentModel: { keyConfigured: false } } });
  await click("Agent");
  expect(container.querySelector("textarea")!.value).toBe("配置后再发送");
  expect(container.querySelector("textarea")!.disabled).toBe(true);
});


it("返回时配置刷新失败不会遮挡会话和草稿", async () => {
  await enterMessage("保留草稿");
  await click("配置");
  api.loadAgent.mockRejectedValueOnce(new Error("连接暂时不可用"));
  await click("Agent");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("连接暂时不可用");
  expect(container.querySelector("textarea")!.value).toBe("保留草稿");
});

it("新一轮对话清空上一轮记忆写入状态，后续事件不会恢复旧结果", async () => {
  const onBackground = api.subscribeBackgroundEvents.mock.calls[0]![0];
  await act(async () => {
    onBackground("memory_task_started", {});
    onBackground("memory_change_completed", {});
  });
  const states = () => JSON.parse(container.querySelector('[data-testid="graph-states"]')!.textContent!);
  expect(states().memory_queue).toBe("done");
  api.runAgent.mockImplementation(() => new Promise(() => {}));
  await enterMessage("新的对话");
  await click("发送");
  for (const id of ["memory_queue", "memory_review", "memory_commit", "semantic_store"])
    expect(states()[id] ?? "idle").toBe("idle");
  await act(async () => onBackground("consolidation_started", {}));
  expect(states().memory_queue ?? "idle").toBe("idle");
  await act(async () => onBackground("memory_task_started", {}));
  expect(states().memory_review).toBe("running");
});

it("整理进行中发起新对话，只清空记忆写入连线，保留整理连线", async () => {
  const onBackground = api.subscribeBackgroundEvents.mock.calls[0]![0];
  await act(async () => {
    onBackground("memory_task_started", {});
    onBackground("consolidation_started", {});
  });
  const edges = () => JSON.parse(container.querySelector('[data-testid="graph-edges"]')!.textContent!) as string[];
  const states = () => JSON.parse(container.querySelector('[data-testid="graph-states"]')!.textContent!);
  expect(edges()).toContain("memory_queue->memory_review");
  expect(edges()).toContain("consolidate_trigger->consolidate_snapshot");
  api.runAgent.mockImplementation(() => new Promise(() => {}));
  await enterMessage("新的对话");
  await click("发送");
  expect(edges()).not.toContain("memory_queue->memory_review");
  // 整理是与回合无关的后台流程，模型调用期间没有新事件，连线一旦被清就再也不会亮起。
  expect(edges()).toContain("consolidate_trigger->consolidate_snapshot");
  expect(states().consolidate_snapshot).toBe("running");
});
