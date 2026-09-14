import type { AgentObserver } from "../agent-loop/agent-loop.ts";
import type { ApprovalGate, ApprovalRequest } from "../tools/approval.ts";

/** 待确认请求的公开投影，供界面渲染确认卡。 */
export interface PendingApproval extends ApprovalRequest {
  id: string;
  createdAt: string;
}

/**
 * 进程内的人工审批通道。
 *
 * 事件流是单向的：请求经 observer 推给界面，用户的决定由一个独立的 HTTP 请求
 * 送回来，在这里找到对应的 Promise 并兑现。审批只存在于内存中，进程重启即全部
 * 取消——本地单用户场景下，重启本就意味着这一轮已经结束。
 */
export class ApprovalRegistry implements ApprovalGate {
  private readonly waiting = new Map<string, { request: PendingApproval; settle: (approved: boolean) => void }>();
  private readonly notify: AgentObserver;

  constructor(notify: AgentObserver) {
    this.notify = notify;
  }

  /** 列出当前待确认的请求，供界面在重新连接后恢复。 */
  pending(): PendingApproval[] {
    return [...this.waiting.values()].map((entry) => entry.request);
  }

  async request(input: ApprovalRequest, signal: AbortSignal | undefined): Promise<boolean> {
    if (signal?.aborted) throw signal.reason;
    const pending: PendingApproval = { ...input, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    const decision = new Promise<boolean>((resolve) => {
      this.waiting.set(pending.id, { request: pending, settle: resolve });
    });
    // 取消整轮运行时不能让这里继续挂着，否则运行永远不会结束。
    const onAbort = (): void => { this.settle(pending.id, false); };
    signal?.addEventListener("abort", onAbort, { once: true });

    await this.notify("approval_requested", {
      approvalId: pending.id,
      kind: pending.kind,
      command: pending.command,
      reason: pending.reason,
      ...(pending.detail === undefined ? {} : { detail: pending.detail }),
    });
    try {
      const approved = await decision;
      if (signal?.aborted) throw signal.reason;
      await this.notify("approval_resolved", { approvalId: pending.id, approved });
      return approved;
    } finally {
      this.waiting.delete(pending.id);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** 兑现一次等待中的审批；返回 false 表示该请求已不存在。 */
  settle(id: string, approved: boolean): boolean {
    const entry = this.waiting.get(id);
    if (entry === undefined) return false;
    this.waiting.delete(id);
    entry.settle(approved);
    return true;
  }

  /** 连接断开或运行结束时，把所有等待中的请求按拒绝处理。 */
  rejectAll(): void {
    for (const id of [...this.waiting.keys()]) this.settle(id, false);
  }
}
