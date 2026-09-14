import { statSync } from "node:fs";
import { resolve } from "node:path";
import { executeSandboxed } from "./execute.ts";
import type { Sandbox, SandboxCommand, SandboxEnforcement, SandboxKind, SandboxPolicy, SandboxResult } from "./types.ts";

/** Linux 与 WSL2 使用的沙箱包装器，按 PATH 解析。 */
export const BUBBLEWRAP_COMMAND = "bwrap";

/** 拒读路径在文件系统中的形态，决定用哪种挂载遮挡。 */
export type PathKind = "directory" | "file" | "missing";

/**
 * 组装 bubblewrap 参数。
 *
 * 与 Seatbelt 的规则模型不同，bubblewrap 靠挂载命名空间表达边界：后出现的挂载
 * 覆盖先出现的，因此顺序是「全盘只读 → 可写区改为读写 → 拒写区改回只读」。
 *
 * 拒读路径的形态必须在每次执行前重新判定：用文件的方式遮挡一个目录会让 bwrap
 * 直接启动失败，进而让所有命令一起失败，而不是只丢掉这一条规则。
 */
export function buildBubblewrapArgs(
  policy: SandboxPolicy,
  pathKind: (path: string) => PathKind = defaultPathKind,
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
    // 目录盖成空 tmpfs，文件盖成 /dev/null；不存在的路径无需遮挡，挂载它反而会让 bwrap 起不来。
    const kind = pathKind(absolute);
    if (kind === "directory") args.push("--tmpfs", absolute);
    else if (kind === "file") args.push("--ro-bind", "/dev/null", absolute);
  }
  if (!policy.allowNetwork) args.push("--unshare-net");
  return args;
}

/** 基于 bubblewrap 的沙箱，用于 Linux 与 WSL2。 */
export class BubblewrapSandbox implements Sandbox {
  readonly kind: SandboxKind = "bubblewrap";
  readonly enforces: SandboxEnforcement = { filesystem: true, network: true };
  private readonly policy: SandboxPolicy;

  constructor(policy: SandboxPolicy) {
    this.policy = policy;
  }

  run(command: SandboxCommand): Promise<SandboxResult> {
    // 每次执行都重新组装：拒读路径可能在两次执行之间被创建、删除或改变形态。
    const args = [...buildBubblewrapArgs(this.policy), "--", "/bin/sh", "-c", command.command];
    return executeSandboxed(BUBBLEWRAP_COMMAND, args, command, this.enforces);
  }
}

function defaultPathKind(path: string): PathKind {
  try {
    return statSync(path).isDirectory() ? "directory" : "file";
  } catch {
    return "missing";
  }
}
