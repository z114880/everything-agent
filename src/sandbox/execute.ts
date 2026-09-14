import { spawn } from "node:child_process";
import type { SandboxCommand, SandboxDenialHint, SandboxEnforcement, SandboxResult } from "./types.ts";

/** stdout 与 stderr 各自保留的头部与尾部字节上限。 */
const OUTPUT_KEEP_BYTES = 16_384;
/** SIGTERM 之后等待进程自行退出的时间，超过则 SIGKILL。 */
const KILL_GRACE_MS = 500;

/** 文件系统拒绝在命令侧只表现为普通权限错误。 */
const FILESYSTEM_DENIAL = /Operation not permitted|Permission denied|Read-only file system/i;
/** 断网后各类客户端报出的连接失败措辞。 */
const NETWORK_DENIAL = /Could not resolve host|Connection refused|Network is unreachable|Couldn't connect|Temporary failure in name resolution|nodename nor servname/i;

/**
 * 以给定的沙箱包装器执行命令，统一处理超时、进程组回收与输出截断。
 *
 * 子进程以独立进程组启动，超时或取消时整组回收，避免 `pnpm test` 这类命令
 * 派生的子进程在父进程被杀后残留。
 */
export async function executeSandboxed(
  file: string,
  args: readonly string[],
  command: SandboxCommand,
  enforces: SandboxEnforcement,
): Promise<SandboxResult> {
  if (command.signal?.aborted) throw command.signal.reason;

  const stdout = new OutputCollector();
  const stderr = new OutputCollector();
  const child = spawn(file, [...args], {
    cwd: command.cwd,
    env: command.env,
    // stdin 关闭：交互式提示在无人值守的执行里只会挂死，不会等到输入。
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  let timedOut = false;
  let killTimer: NodeJS.Timeout | undefined;
  const killGroup = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // 进程组已退出，无需处理。
    }
  };
  const terminate = (): void => {
    killGroup("SIGTERM");
    killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref();
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, command.timeoutMs);
  const onAbort = (): void => terminate();
  command.signal?.addEventListener("abort", onAbort, { once: true });

  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    if (command.signal?.aborted) throw command.signal.reason;
    const stderrText = stderr.text();
    return {
      exitCode,
      stdout: stdout.text(),
      stderr: stderrText,
      truncated: stdout.truncated || stderr.truncated,
      timedOut,
      denialHint: exitCode === 0 ? null : detectDenial(stderrText, enforces),
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    command.signal?.removeEventListener("abort", onAbort);
  }
}

/** 按 stderr 措辞猜测命令撞上了哪一层边界；对应层未生效时不给提示。 */
function detectDenial(stderr: string, enforces: SandboxEnforcement): SandboxDenialHint {
  if (enforces.network && NETWORK_DENIAL.test(stderr)) return "network";
  if (enforces.filesystem && FILESYSTEM_DENIAL.test(stderr)) return "filesystem";
  return null;
}

/** 保留输出的首尾两段，丢弃中间部分，避免一次构建日志撑爆模型上下文。 */
class OutputCollector {
  private readonly head: Buffer[] = [];
  private readonly tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private droppedBytes = 0;

  push(chunk: Buffer): void {
    let rest = chunk;
    if (this.headBytes < OUTPUT_KEEP_BYTES) {
      const room = OUTPUT_KEEP_BYTES - this.headBytes;
      if (rest.length <= room) {
        this.head.push(rest);
        this.headBytes += rest.length;
        return;
      }
      this.head.push(rest.subarray(0, room));
      this.headBytes = OUTPUT_KEEP_BYTES;
      rest = rest.subarray(room);
    }
    this.tail.push(rest);
    this.tailBytes += rest.length;
    this.trimTail();
  }

  private trimTail(): void {
    while (this.tailBytes > OUTPUT_KEEP_BYTES) {
      const first = this.tail[0];
      if (first === undefined) return;
      const excess = this.tailBytes - OUTPUT_KEEP_BYTES;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailBytes -= first.length;
        this.droppedBytes += first.length;
        continue;
      }
      this.tail[0] = first.subarray(excess);
      this.tailBytes -= excess;
      this.droppedBytes += excess;
    }
  }

  get truncated(): boolean {
    return this.droppedBytes > 0;
  }

  text(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    const tail = Buffer.concat(this.tail).toString("utf8");
    if (this.droppedBytes === 0) return head + tail;
    return `${head}\n…… 已省略 ${this.droppedBytes} 字节 ……\n${tail}`;
  }
}
