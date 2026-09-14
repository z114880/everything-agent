import { describe, expect, it, vi } from "vitest";
import { ApprovalRegistry } from "../approval-registry.ts";
import type { EventData } from "../../agent-loop/types.ts";

/** 收集 observer 事件，验证请求确实被推给了界面。 */
function createNotify() {
  const events: { kind: string; event: EventData }[] = [];
  return { events, notify: (kind: string, event: EventData) => void events.push({ kind, event }) };
}

const request = { kind: "irreversible" as const, command: "git push", reason: "向远端推送提交" };

describe("人工审批注册表", () => {
  it("推送请求事件并在用户同意后兑现", async () => {
    const { events, notify } = createNotify();
    const registry = new ApprovalRegistry(notify);
    const pending = registry.request(request, undefined);
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1));

    const requested = events.find((item) => item.kind === "approval_requested");
    expect(requested?.event.command).toBe("git push");
    expect(requested?.event.reason).toBe("向远端推送提交");
    const approvalId = requested?.event.approvalId as string;

    expect(registry.settle(approvalId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    expect(events.some((item) => item.kind === "approval_resolved" && item.event.approved === true)).toBe(true);
    expect(registry.pending()).toHaveLength(0);
  });

  it("用户拒绝时解析为 false", async () => {
    const { events, notify } = createNotify();
    const registry = new ApprovalRegistry(notify);
    const pending = registry.request(request, undefined);
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1));
    registry.settle(registry.pending()[0]!.id, false);
    await expect(pending).resolves.toBe(false);
    expect(events.some((item) => item.kind === "approval_resolved" && item.event.approved === false)).toBe(true);
  });

  it("兑现未知请求返回 false", () => {
    const registry = new ApprovalRegistry(createNotify().notify);
    expect(registry.settle("不存在的编号", true)).toBe(false);
  });

  it("已取消的运行不再发起请求", async () => {
    const registry = new ApprovalRegistry(createNotify().notify);
    const controller = new AbortController();
    controller.abort(new Error("用户停止"));
    await expect(registry.request(request, controller.signal)).rejects.toThrow("用户停止");
  });

  it("等待期间取消运行会中止请求，不会一直挂着", async () => {
    const registry = new ApprovalRegistry(createNotify().notify);
    const controller = new AbortController();
    const pending = registry.request(request, controller.signal);
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1));
    controller.abort(new Error("用户停止"));
    await expect(pending).rejects.toThrow("用户停止");
    expect(registry.pending()).toHaveLength(0);
  });

  it("连接断开时把全部等待中的请求按拒绝处理", async () => {
    const registry = new ApprovalRegistry(createNotify().notify);
    const first = registry.request(request, undefined);
    const second = registry.request({ ...request, command: "pnpm publish" }, undefined);
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(2));
    registry.rejectAll();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    expect(registry.pending()).toHaveLength(0);
  });

  it("待确认列表带出展示所需的字段", async () => {
    const registry = new ApprovalRegistry(createNotify().notify);
    void registry.request({ ...request, detail: "确认后仅本次放行" }, undefined);
    await vi.waitFor(() => expect(registry.pending()).toHaveLength(1));
    const [item] = registry.pending();
    expect(item).toMatchObject({ command: "git push", reason: "向远端推送提交", detail: "确认后仅本次放行" });
    expect(typeof item?.id).toBe("string");
    expect(typeof item?.createdAt).toBe("string");
    registry.rejectAll();
  });
});
