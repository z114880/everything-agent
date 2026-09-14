import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_TERMINAL_TOOL, TerminalTool, runTerminalSchema } from "../terminal.ts";
import { LocalToolRegistry } from "../tool-registry.ts";
import { publicToolEvent } from "../../agent-runtime/events/tool-events.ts";
import type { Sandbox, SandboxCommand, SandboxResult } from "../../sandbox/index.ts";
import type { ApprovalGate, ApprovalRequest } from "../approval.ts";
import type { AgentObserver, ToolExecutionContext } from "../../agent-loop/agent-loop.ts";

const context: ToolExecutionContext = { signal: undefined, deadline: null, iteration: 1, toolUseId: "call-1" };
const noop: AgentObserver = () => {};

/** 记录收到的命令，避免单元测试依赖真实沙箱。 */
class RecordingSandbox implements Sandbox {
  readonly kind = "seatbelt" as const;
  readonly enforces = { filesystem: true, network: true };
  readonly calls: SandboxCommand[] = [];
  result: SandboxResult = {
    exitCode: 0,
    stdout: "输出",
    stderr: "",
    truncated: false,
    timedOut: false,
    denialHint: null,
  };

  /** 按命令定制结果，用于模拟 git status 与沙箱拒绝。 */
  respond: ((command: string) => Partial<SandboxResult>) | null = null;

  run(command: SandboxCommand): Promise<SandboxResult> {
    this.calls.push(command);
    const override = this.respond?.(command.command) ?? {};
    return Promise.resolve({ ...this.result, ...override });
  }
}

/** 固定答复的审批通道，记录收到的请求。 */
class StubApproval implements ApprovalGate {
  readonly requests: ApprovalRequest[] = [];
  private readonly answer: boolean;

  constructor(answer: boolean) {
    this.answer = answer;
  }

  request(input: ApprovalRequest): Promise<boolean> {
    this.requests.push(input);
    return Promise.resolve(this.answer);
  }
}

let root = "";
let workspace = "";
let tempDir = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "everything-terminal-"));
  workspace = join(root, "workspace");
  tempDir = join(root, "tmp");
  mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
  if (root !== "") rmSync(root, { recursive: true, force: true });
});

function createTool(sandbox: Sandbox = new RecordingSandbox()): TerminalTool {
  return new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox });
}

describe("run_terminal 参数校验", () => {
  it("拒绝非对象参数", async () => {
    await expect(createTool().execute("ls", noop, context)).rejects.toThrow(/必须是对象/);
  });

  it("拒绝空命令", async () => {
    await expect(createTool().execute({ command: "   " }, noop, context)).rejects.toThrow(/command/);
  });

  it("拒绝超长命令", async () => {
    await expect(createTool().execute({ command: "x".repeat(10_001) }, noop, context)).rejects.toThrow(/command/);
  });

  it("拒绝未知参数", async () => {
    await expect(createTool().execute({ command: "ls", shell: "zsh" }, noop, context)).rejects.toThrow(/不支持参数/);
  });

  it("拒绝绝对路径的 workdir", async () => {
    await expect(createTool().execute({ command: "ls", workdir: "/etc" }, noop, context)).rejects.toThrow(/相对/);
  });

  it("拒绝越出工作区的 workdir", async () => {
    await expect(createTool().execute({ command: "ls", workdir: "../.." }, noop, context)).rejects.toThrow(/工作区内/);
  });

  it("拒绝非字符串 workdir", async () => {
    await expect(createTool().execute({ command: "ls", workdir: 1 }, noop, context)).rejects.toThrow(/workdir/);
  });

  it("拒绝越界的 timeout_ms", async () => {
    await expect(createTool().execute({ command: "ls", timeout_ms: 10 }, noop, context)).rejects.toThrow(/timeout_ms/);
    await expect(createTool().execute({ command: "ls", timeout_ms: 999_999 }, noop, context)).rejects.toThrow(/timeout_ms/);
  });

  it("工作区根与临时目录必须是绝对路径", () => {
    expect(() => new TerminalTool({ workspaceRoot: "relative", sessionTempDir: tempDir })).toThrow(/绝对路径/);
    expect(() => new TerminalTool({ workspaceRoot: workspace, sessionTempDir: "relative" })).toThrow(/绝对路径/);
  });

  it("取消信号在执行前生效", async () => {
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));
    await expect(createTool().execute({ command: "ls" }, noop, { ...context, signal: controller.signal }))
      .rejects.toThrow("用户取消");
  });
});

describe("run_terminal 交给沙箱的请求", () => {
  it("默认在工作区根执行并注入 TMPDIR", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls -a" }, noop, context);
    const call = sandbox.calls[0];
    expect(call?.command).toBe("ls -a");
    expect(call?.cwd).toBe(workspace);
    expect(call?.env.TMPDIR).toBe(tempDir);
    expect(call?.timeoutMs).toBe(120_000);
  });

  it("子目录 workdir 解析到工作区内", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls", workdir: "src/tools" }, noop, context);
    expect(sandbox.calls[0]?.cwd).toBe(join(workspace, "src", "tools"));
  });

  it("传入的 timeout_ms 覆盖默认值", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls", timeout_ms: 5_000 }, noop, context);
    expect(sandbox.calls[0]?.timeoutMs).toBe(5_000);
  });

  it("环境变量不含父进程凭证", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls" }, noop, context);
    expect(Object.keys(sandbox.calls[0]?.env ?? {})).not.toContain("TAVILY_API_KEY");
  });

  it("结果保留退出码、截断标记与沙箱类型", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.result = { exitCode: 1, stdout: "", stderr: "Operation not permitted", truncated: true, timedOut: false, denialHint: "filesystem" };
    const result = await createTool(sandbox).execute({ command: "ls", workdir: "src" }, noop, context);
    expect(result).toMatchObject({
      exitCode: 1,
      truncated: true,
      denialHint: "filesystem",
      sandbox: "seatbelt",
      workdir: "src",
    });
  });

  it("工作区根本身的 workdir 记为当前目录", async () => {
    const result = await createTool().execute({ command: "ls" }, noop, context);
    expect(result.workdir).toBe(".");
  });
});

describe("run_terminal 在注册表中的可见性", () => {
  const schemaNames = (registry: LocalToolRegistry) =>
    (registry.schemas() as { name: string }[]).map((schema) => schema.name);

  it("未启用时模型看不到该工具", () => {
    const registry = new LocalToolRegistry(undefined, undefined, undefined, undefined, { terminalEnabled: false });
    expect(schemaNames(registry)).not.toContain(RUN_TERMINAL_TOOL);
    expect(registry.terminalUnavailableReason).toBeNull();
  });

  it("启用但未配置工作区时不注册，并给出原因", () => {
    const registry = new LocalToolRegistry(undefined, undefined, undefined, undefined, { terminalEnabled: true });
    expect(schemaNames(registry)).not.toContain(RUN_TERMINAL_TOOL);
    expect(registry.terminalUnavailableReason).toContain("工作区");
  });

  it("配置完整时注册工具", () => {
    const registry = new LocalToolRegistry(undefined, undefined, undefined, undefined, {
      terminalEnabled: true,
      terminalWorkspaceRoot: workspace,
      terminalSessionTempDir: tempDir,
    });
    const registered = schemaNames(registry).includes(RUN_TERMINAL_TOOL);
    // 沙箱不可用的平台上工具不会注册，此时必须给出原因而不是静默缺失。
    expect(registered || registry.terminalUnavailableReason !== null).toBe(true);
  });

  it("未注册时调用会明确报错", async () => {
    const registry = new LocalToolRegistry(undefined, undefined, undefined, undefined, { terminalEnabled: false });
    expect(() => registry.execute(RUN_TERMINAL_TOOL, { command: "ls" }, () => {}, context))
      .toThrow(/工具未注册/);
  });

  it("schema 声明了沙箱约束，便于模型预期失败", () => {
    expect(runTerminalSchema.description).toContain("沙箱");
    expect(runTerminalSchema.input_schema.required).toEqual(["command"]);
  });
});

describe.skipIf(process.platform !== "darwin")("run_terminal 真实执行", () => {
  it("在工作区内执行并返回输出", async () => {
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir });
    const result = await tool.execute({ command: "echo 你好 > hello.txt && cat hello.txt" }, noop, context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("你好");
    expect(readFileSync(join(workspace, "hello.txt"), "utf8").trim()).toBe("你好");
    expect(result.sandbox).toBe("seatbelt");
  });

  it("越界写入失败并带出边界提示", async () => {
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir });
    const result = await tool.execute({ command: `echo 越界 > ${JSON.stringify(join(root, "leak.txt"))}` }, noop, context);
    expect(result.exitCode).not.toBe(0);
    expect(result.denialHint).toBe("filesystem");
  });
});

describe("run_terminal 人工审批", () => {
  function build(answer: boolean, respond: ((command: string) => Partial<SandboxResult>) | null = null) {
    const sandbox = new RecordingSandbox();
    sandbox.respond = respond;
    const approval = new StubApproval(answer);
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox, approval });
    return { sandbox, approval, tool };
  }

  it("硬拒命令不执行并上报事件", async () => {
    const { sandbox, tool } = build(true);
    const events: string[] = [];
    await expect(tool.execute({ command: "rm -rf /" }, (kind) => void events.push(kind), context))
      .rejects.toThrow(/递归删除根目录/);
    expect(sandbox.calls).toHaveLength(0);
    expect(events).toContain("command_blocked");
  });

  it("外部可见操作在确认后执行，并标记已确认", async () => {
    const { sandbox, approval, tool } = build(true);
    const result = await tool.execute({ command: "git push origin master" }, noop, context);
    expect(approval.requests[0]?.reason).toContain("远端");
    expect(sandbox.calls.map((call) => call.command)).toContain("git push origin master");
    expect(result.approved).toBe(true);
  });

  it("用户拒绝时命令不执行", async () => {
    const { sandbox, tool } = build(false);
    await expect(tool.execute({ command: "git push" }, noop, context)).rejects.toThrow(/未确认/);
    expect(sandbox.calls).toHaveLength(0);
  });

  it("没有审批通道时需要审批的命令一律拒绝", async () => {
    const sandbox = new RecordingSandbox();
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox });
    await expect(tool.execute({ command: "git push" }, noop, context)).rejects.toThrow(/未确认/);
    expect(sandbox.calls).toHaveLength(0);
  });

  it("会丢弃工作成果的命令需要确认，且不额外执行 git 查询", async () => {
    const { sandbox, approval, tool } = build(true);
    const result = await tool.execute({ command: "git reset --hard HEAD~1" }, noop, context);
    expect(approval.requests[0]?.reason).toContain("未提交");
    expect(result.approved).toBe(true);
    // 判定只看命令文本：整轮只应执行用户那一条命令。
    expect(sandbox.calls.map((call) => call.command)).toEqual(["git reset --hard HEAD~1"]);
  });

  it("网络越界经确认后放行网络重跑", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.respond = () => ({ exitCode: 6, denialHint: "network" });
    const networkSandbox = new RecordingSandbox();
    const approval = new StubApproval(true);
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox, networkSandbox, approval });
    const events: string[] = [];
    const result = await tool.execute({ command: "curl https://example.com" }, (kind) => void events.push(kind), context);
    expect(events).toContain("sandbox_denied");
    expect(approval.requests[0]?.kind).toBe("sandbox_denial");
    expect(networkSandbox.calls).toHaveLength(1);
    expect(result).toMatchObject({ exitCode: 0, networkAllowed: true, approved: true });
  });

  it("网络越界未获确认时返回原始失败结果", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.respond = () => ({ exitCode: 6, denialHint: "network" });
    const networkSandbox = new RecordingSandbox();
    const approval = new StubApproval(false);
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox, networkSandbox, approval });
    const result = await tool.execute({ command: "curl https://example.com" }, noop, context);
    expect(networkSandbox.calls).toHaveLength(0);
    expect(result).toMatchObject({ exitCode: 6, denialHint: "network" });
    expect(result.networkAllowed).toBeUndefined();
  });

  // 未注入 networkSandbox 时会按放行网络的策略真实创建一个沙箱；命令本身不联网。
  it.skipIf(process.platform !== "darwin")("放行网络后按新策略真实建立沙箱", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.respond = () => ({ exitCode: 6, denialHint: "network" });
    const approval = new StubApproval(true);
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox, approval });
    const result = await tool.execute({ command: "echo 已放行" }, noop, context);
    expect(result).toMatchObject({ exitCode: 0, networkAllowed: true });
    expect(result.stdout.trim()).toBe("已放行");
  });

  it("文件系统越界不提供放宽重试", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.respond = () => ({ exitCode: 1, denialHint: "filesystem" });
    const approval = new StubApproval(true);
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir, sandbox, approval });
    const result = await tool.execute({ command: "echo x > /etc/hosts" }, noop, context);
    expect(approval.requests).toHaveLength(0);
    expect(result.denialHint).toBe("filesystem");
  });
});

describe("终端事件投影", () => {
  it("事件流只保留命令与边界信息，不携带完整输出", () => {
    const projected = publicToolEvent({
      tool: "run_terminal",
      args: { command: "pnpm test" },
      result: {
        command: "pnpm test", workdir: ".", exitCode: 0,
        stdout: "x".repeat(5_000), stderr: "", truncated: true, timedOut: false,
        denialHint: null, sandbox: "seatbelt", approved: true,
      },
      output: "",
      toolUseId: "call-1",
      iteration: 1,
      isError: false,
    });
    const result = projected.result as Record<string, unknown>;
    expect(result.command).toBe("pnpm test");
    expect(result.sandbox).toBe("seatbelt");
    expect(result.approved).toBe(true);
    expect(result.stdoutLength).toBe(5_000);
    expect(result.stdout).toBeUndefined();
    expect(JSON.stringify(projected).length).toBeLessThan(1_000);
  });

  it("结果形状异常时不泄露原始值", () => {
    const projected = publicToolEvent({
      tool: "run_terminal", args: {}, result: "原始文本", output: "",
      toolUseId: "call-2", iteration: 1, isError: false,
    });
    expect(projected.result).toEqual({ redacted: true });
  });
});
