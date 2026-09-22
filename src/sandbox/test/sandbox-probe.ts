import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxEnv, SeatbeltSandbox } from "../index.ts";

export interface SeatbeltProbe {
  usable: boolean;
  reason: string;
}

/**
 * 真实执行一条最小命令，确认当前进程能建立 seatbelt 沙箱。
 *
 * 只判断 `process.platform` 不足够：在嵌套沙箱或缺少权限的环境里 `sandbox-exec` 会以
 * `sandbox_apply: Operation not permitted` 失败（退出码 71）。此时依赖「被拒绝」的边界
 * 用例会因为退出码非 0 而假通过，依赖「执行成功」的用例则整片失败。真实沙箱用例必须按
 * 能力跳过，并在跳过时说明原因，而不是把平台判断当成能力判断。
 */
export async function probeSeatbelt(): Promise<SeatbeltProbe> {
  if (process.platform !== "darwin") {
    return { usable: false, reason: `当前平台 ${process.platform} 不提供 seatbelt` };
  }
  const root = mkdtempSync(join(tmpdir(), "everything-sandbox-probe-"));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    const sandbox = new SeatbeltSandbox({
      workspaceRoot: workspace,
      writableRoots: [],
      denyWrite: [],
      denyRead: [],
      allowNetwork: false,
    });
    const result = await sandbox.run({ command: "echo ok", cwd: workspace, timeoutMs: 15_000, env: buildSandboxEnv() });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "";
      return { usable: false, reason: `seatbelt 无法建立：${detail || `退出码 ${result.exitCode}`}` };
    }
    return { usable: true, reason: "" };
  } catch (error) {
    return { usable: false, reason: `seatbelt 探测失败：${error instanceof Error ? error.message : String(error)}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** 探测结果与跳过原因一并打印，避免「跳过」被误读成「通过」。 */
export function reportSkippedRealSandbox(probe: SeatbeltProbe): void {
  if (!probe.usable) console.warn(`跳过真实沙箱用例：${probe.reason}`);
}
