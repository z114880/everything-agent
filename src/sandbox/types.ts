/** 当前进程可用的沙箱实现类型。 */
export type SandboxKind = "seatbelt" | "bubblewrap";

/**
 * 沙箱实际能强制的边界。
 *
 * 上层策略据此决定审批强度，不要改为判断 `kind`：新增实现时判断会漏。
 */
export interface SandboxEnforcement {
  filesystem: boolean;
  network: boolean;
}

/**
 * 与平台无关的边界描述。
 *
 * 所有路径必须是绝对路径，由调用方负责解析；沙箱实现只做拼装，不做路径校验，
 * 因为真正的边界由内核在每次系统调用时判定，用户态校验挡不住符号链接替换。
 */
export interface SandboxPolicy {
  /** 唯一的工作区根，命令的写入范围。 */
  workspaceRoot: string;
  /** 工作区之外仍然可写的路径，用于会话临时目录。 */
  writableRoots: readonly string[];
  /** 可写区域内部再挖掉的路径，优先级高于 `workspaceRoot`。 */
  denyWrite: readonly string[];
  /** 禁止读取的路径，用于凭证与私钥。 */
  denyRead: readonly string[];
  /** 是否放行出站网络；默认关闭，放行只应来自一次人工审批。 */
  allowNetwork: boolean;
}

/** 一条待执行命令及其运行约束。 */
export interface SandboxCommand {
  /** 交给 `/bin/sh -c` 的完整命令行。 */
  command: string;
  /** 工作目录，必须位于可写范围内。 */
  cwd: string;
  /** 单条命令超时；超时后先 SIGTERM 再 SIGKILL。 */
  timeoutMs: number;
  /** 传给子进程的完整环境变量，调用方必须显式构造，不会继承父进程。 */
  env: Record<string, string>;
  /** 取消信号，来自 Agent 运行级取消。 */
  signal?: AbortSignal | undefined;
}

/**
 * 沙箱拒绝的启发式提示。
 *
 * 内核不会把拒绝原因回传给进程，命令只会看到普通的权限错误，因此这里只能按
 * 退出码与 stderr 模式猜测。它用于给模型和用户一个方向，不是权威判定。
 */
export type SandboxDenialHint = "filesystem" | "network" | null;

/** 一次沙箱执行的结果。 */
export interface SandboxResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** 输出是否因超过上限被截断。 */
  truncated: boolean;
  timedOut: boolean;
  /** 命令是否可能撞上了沙箱边界，供上层决定是否发起审批。 */
  denialHint: SandboxDenialHint;
}

/** 平台沙箱实现的统一接口。 */
export interface Sandbox {
  readonly kind: SandboxKind;
  readonly enforces: SandboxEnforcement;
  run(command: SandboxCommand): Promise<SandboxResult>;
}
