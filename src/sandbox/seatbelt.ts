import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { executeSandboxed } from "./execute.ts";
import type { Sandbox, SandboxCommand, SandboxEnforcement, SandboxKind, SandboxPolicy, SandboxResult } from "./types.ts";

/** macOS 自带的沙箱包装器。 */
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/**
 * 生成 Seatbelt 策略文本。
 *
 * SBPL 采用后匹配优先，因此每条 deny 都必须排在对应的 allow 之后，否则会被
 * 后面的 allow 静默覆盖；策略失效时命令照常执行，不会有任何报错。
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const writable = [policy.workspaceRoot, ...policy.writableRoots].map(canonicalPath);
  const lines = [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process-exec process-fork)",
    "(allow sysctl-read)",
    "(allow file-read*)",
  ];
  for (const path of policy.denyRead) lines.push(`(deny file-read* ${subpath(path)})`);
  // workspaceRoot 必填，可写列表恒非空。
  lines.push(`(allow file-write* ${writable.map(subpathOf).join(" ")})`);
  for (const path of policy.denyWrite) lines.push(`(deny file-write* ${subpath(path)})`);
  lines.push(policy.allowNetwork ? "(allow network*)" : "(deny network*)");
  return `${lines.join("\n")}\n`;
}

/** 基于 macOS Seatbelt 的沙箱；文件系统与网络边界都由内核强制。 */
export class SeatbeltSandbox implements Sandbox {
  readonly kind: SandboxKind = "seatbelt";
  readonly enforces: SandboxEnforcement = { filesystem: true, network: true };
  private readonly profile: string;

  constructor(policy: SandboxPolicy) {
    this.profile = buildSeatbeltProfile(policy);
  }

  run(command: SandboxCommand): Promise<SandboxResult> {
    const args = ["-p", this.profile, "/bin/sh", "-c", command.command];
    return executeSandboxed(SANDBOX_EXEC_PATH, args, command, this.enforces);
  }
}

/**
 * 解析为真实路径，让规则匹配内核看到的路径。
 *
 * macOS 的 `/tmp` 与 `/var` 都是符号链接，不解析会让规则对实际路径不生效。
 * 这一步只为策略正确，不承担安全职责：防止符号链接逃逸的是内核在每次系统
 * 调用时的判定，不是这里的用户态解析。
 */
function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function subpath(path: string): string {
  return subpathOf(canonicalPath(path));
}

function subpathOf(path: string): string {
  return `(subpath ${quote(path)})`;
}

/** SBPL 字符串字面量只需转义反斜杠与双引号。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
