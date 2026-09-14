import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { buildSandboxEnv, createSandbox } from "../sandbox/index.ts";
import type { Sandbox, SandboxDenialHint } from "../sandbox/index.ts";
import type { ToolExecutionContext } from "../agent-loop/types.ts";

export const RUN_TERMINAL_TOOL = "run_terminal";

/** 单条命令的默认与最大超时。 */
export const DEFAULT_TERMINAL_TIMEOUT_MS = 120_000;
const MAX_TERMINAL_TIMEOUT_MS = 600_000;
const MIN_TERMINAL_TIMEOUT_MS = 1_000;
const MAX_COMMAND_LENGTH = 10_000;

export const runTerminalSchema = {
  name: RUN_TERMINAL_TOOL,
  description: [
    "在工作区内执行 shell 命令，用于读取文件、构建、测试和修改代码。",
    "命令运行在操作系统沙箱内：只能写入工作区，无法访问网络，也无法读取凭证目录。",
    "工作区内的 .git 目录不可写。越界操作会失败并在结果中说明。",
  ].join(""),
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string", description: "交给 /bin/sh 执行的完整命令行，支持管道与重定向。" },
      workdir: { type: "string", description: "相对工作区根的子目录，省略时在工作区根执行。" },
      timeout_ms: {
        type: "integer",
        minimum: MIN_TERMINAL_TIMEOUT_MS,
        maximum: MAX_TERMINAL_TIMEOUT_MS,
        description: `命令超时，默认 ${DEFAULT_TERMINAL_TIMEOUT_MS} 毫秒。`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
} as const;

/** 终端工具的运行配置；`workspaceRoot` 必须由使用方显式指定。 */
export interface TerminalToolOptions {
  workspaceRoot: string;
  /** 工作区之外仍可写的临时目录，同时作为子进程的 TMPDIR。 */
  sessionTempDir: string;
  /** 额外的拒读路径，默认包含常见凭证目录。 */
  denyRead?: readonly string[];
  defaultTimeoutMs?: number;
  /** 注入沙箱实现，省略时按当前平台探测。 */
  sandbox?: Sandbox;
}

/** 一次终端执行的结构化结果。 */
export interface TerminalToolResult {
  command: string;
  workdir: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  /** 命令可能撞上的沙箱边界，供上层决定是否发起审批。 */
  denialHint: SandboxDenialHint;
  sandbox: string;
}

/**
 * 在内核沙箱内执行 shell 命令。
 *
 * 不对命令文本做危险模式匹配：编码与变量展开可以轻易绕过任何字符串检查，
 * 真正的边界由沙箱在系统调用层给出。
 */
export class TerminalTool {
  private readonly workspaceRoot: string;
  private readonly sessionTempDir: string;
  private readonly defaultTimeoutMs: number;
  private readonly sandbox: Sandbox;

  constructor(options: TerminalToolOptions) {
    this.workspaceRoot = resolve(requireAbsolute(options.workspaceRoot, "workspaceRoot"));
    this.sessionTempDir = resolve(requireAbsolute(options.sessionTempDir, "sessionTempDir"));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TERMINAL_TIMEOUT_MS;
    // 临时目录必须先存在：bubblewrap 无法绑定不存在的路径，TMPDIR 指向缺失目录也会让命令失败。
    mkdirSync(this.sessionTempDir, { recursive: true });
    this.sandbox = options.sandbox ?? createSandbox({
      workspaceRoot: this.workspaceRoot,
      writableRoots: [this.sessionTempDir],
      denyWrite: [join(this.workspaceRoot, ".git"), join(this.workspaceRoot, ".everything")],
      denyRead: options.denyRead ?? defaultDenyRead(),
      allowNetwork: false,
    });
  }

  async execute(value: unknown, context: ToolExecutionContext): Promise<TerminalToolResult> {
    if (context.signal?.aborted) throw context.signal.reason;
    const input = parseTerminalInput(value, this.defaultTimeoutMs);
    const workdir = this.resolveWorkdir(input.workdir);
    const result = await this.sandbox.run({
      command: input.command,
      cwd: workdir,
      timeoutMs: input.timeoutMs,
      env: buildSandboxEnv({ TMPDIR: this.sessionTempDir }),
      signal: context.signal,
    });
    return {
      command: input.command,
      workdir: relative(this.workspaceRoot, workdir) || ".",
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      timedOut: result.timedOut,
      denialHint: result.denialHint,
      sandbox: this.sandbox.kind,
    };
  }

  /**
   * 把相对目录解析到工作区内。
   *
   * 这一步只为给模型清晰的错误信息，不是安全边界：越界写入由内核拒绝，
   * 用户态校验挡不住校验之后的符号链接替换。
   */
  private resolveWorkdir(workdir: string | undefined): string {
    if (workdir === undefined || workdir === "") return this.workspaceRoot;
    if (isAbsolute(workdir)) throw new TypeError("workdir 必须是相对工作区根的路径");
    const target = resolve(this.workspaceRoot, workdir);
    if (target !== this.workspaceRoot && !target.startsWith(this.workspaceRoot + sep)) {
      throw new TypeError("workdir 必须位于工作区内");
    }
    return target;
  }
}

/** 默认遮挡的凭证目录；沙箱只需路径，不要求它们存在。 */
function defaultDenyRead(): string[] {
  const home = process.env.HOME;
  if (home === undefined || home === "") return [];
  return [join(home, ".ssh"), join(home, ".aws"), join(home, ".gnupg"), join(home, ".npmrc")];
}

function parseTerminalInput(
  value: unknown,
  defaultTimeoutMs: number,
): { command: string; workdir: string | undefined; timeoutMs: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("run_terminal 参数必须是对象");
  const input = value as Record<string, unknown>;
  const unknownKeys = Object.keys(input).filter((key) => !["command", "workdir", "timeout_ms"].includes(key));
  if (unknownKeys.length > 0) throw new TypeError(`run_terminal 不支持参数：${unknownKeys.join("、")}`);

  const command = typeof input.command === "string" ? input.command.trim() : "";
  if (!command || command.length > MAX_COMMAND_LENGTH) {
    throw new TypeError(`command 必须是 1–${MAX_COMMAND_LENGTH} 字符的字符串`);
  }
  if (input.workdir !== undefined && typeof input.workdir !== "string") throw new TypeError("workdir 必须是字符串");

  const timeoutMs = input.timeout_ms === undefined ? defaultTimeoutMs : Number(input.timeout_ms);
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TERMINAL_TIMEOUT_MS || timeoutMs > MAX_TERMINAL_TIMEOUT_MS) {
    throw new TypeError(`timeout_ms 必须是 ${MIN_TERMINAL_TIMEOUT_MS}–${MAX_TERMINAL_TIMEOUT_MS} 的整数`);
  }
  return { command, workdir: input.workdir as string | undefined, timeoutMs };
}

function requireAbsolute(path: unknown, field: string): string {
  if (typeof path !== "string" || path === "" || !isAbsolute(path)) throw new TypeError(`${field} 必须是绝对路径`);
  return path;
}
