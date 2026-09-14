import { ShieldAlert } from "lucide-react";
import { Button } from "../../components/ui/button";
import type { PendingApproval } from "../../agent-api";

interface ApprovalPromptProps {
  approvals: PendingApproval[];
  busyId: string;
  onDecide: (approvalId: string, approved: boolean) => void;
}

/**
 * 展示等待人工确认的命令。
 *
 * 沙箱挡不住工作区内部的破坏，也挡不住推送到远端这类外部后果，这些只能由人来
 * 判断；命令原文完整展示，不做省略，确认的依据必须看得见。
 */
export function ApprovalPrompt({ approvals, busyId, onDecide }: ApprovalPromptProps) {
  if (approvals.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {approvals.map((approval) => (
        <div
          key={approval.id}
          className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          role="alertdialog"
          aria-label="命令需要确认"
        >
          <div className="flex items-center gap-2 font-medium text-foreground">
            <ShieldAlert className="size-4 shrink-0 text-amber-600" aria-hidden />
            <span>{approval.reason}</span>
          </div>
          <pre className="mt-2 overflow-x-auto rounded-md bg-background/70 p-2 font-mono text-xs text-foreground">
            {approval.command}
          </pre>
          {approval.detail ? (
            <p className="mt-2 text-xs text-muted-foreground">{approval.detail}</p>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Button
              size="sm"
              disabled={busyId === approval.id}
              onClick={() => onDecide(approval.id, true)}
            >
              允许本次
            </Button>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={busyId === approval.id}
              onClick={() => onDecide(approval.id, false)}
            >
              拒绝
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
