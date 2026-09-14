import { statSync } from "node:fs";
import { resolve } from "node:path";
import { executeSandboxed } from "./execute.ts";
import type { Sandbox, SandboxCommand, SandboxEnforcement, SandboxKind, SandboxPolicy, SandboxResult } from "./types.ts";

/** Linux 与 WSL2 使用的沙箱包装器，按 PATH 解析。 */
export const BUBBLEWRAP_COMMAND = "bwrap";

/**
 * 组装 bubblewrap 参数。
 *
 * 与 Seatbelt 的规则模型不同，bubblewrap 靠挂载命名空间表达边界：后出现的挂载
 * 覆盖先出现的，因此顺序是「全盘只读 → 可写区改为读写 → 拒写区改回只读」。
 */
export function buildBubblewrapArgs(
  policy: SandboxPolicy,
  isDirectory: (path: string) => boolean = defaultIsDirectory,
): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid", "--new-session", "--die-with-parent"];
  for (const path of [policy.workspaceRoot, ...policy.writableRoots]) {
    const absolute = resolve(path);
    args.push("--bind", absolute, absolute);
  }
  for (const path of policy.denyWrite) {
    const absolute = resolve(path);
    args.push("--ro-bind", absolute, absolute);
  }
  for (const path of policy.denyRead) {
    const absolute = resolve(path);
    // 目录盖成空 tmpfs，文件盖成 /dev/null；两者都让内容不可读又不影响路径存在。
    if (isDirectory(absolute)) args.push("--tmpfs", absolute);
    else args.push("--ro-bind", "/dev/null", absolute);
  }
  if (!policy.allowNetwork) args.push("--unshare-net");
  return args;
}

/** 基于 bubblewrap 的沙箱，用于 Linux 与 WSL2。 */
export class BubblewrapSandbox implements Sandbox {
  readonly kind: SandboxKind = "bubblewrap";
  readonly enforces: SandboxEnforcement = { filesystem: true, network: true };
  private readonly args: string[];

  constructor(policy: SandboxPolicy) {
    this.args = buildBubblewrapArgs(policy);
  }

  run(command: SandboxCommand): Promise<SandboxResult> {
    const args = [...this.args, "--", "/bin/sh", "-c", command.command];
    return executeSandboxed(BUBBLEWRAP_COMMAND, args, command, this.enforces);
  }
}

function defaultIsDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
