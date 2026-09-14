import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RUN_TERMINAL_TOOL, TerminalTool, runTerminalSchema } from "../terminal.ts";
import { LocalToolRegistry } from "../tool-registry.ts";
import type { Sandbox, SandboxCommand, SandboxResult } from "../../sandbox/index.ts";
import type { ToolExecutionContext } from "../../agent-loop/agent-loop.ts";

const context: ToolExecutionContext = { signal: undefined, deadline: null, iteration: 1, toolUseId: "call-1" };

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

  run(command: SandboxCommand): Promise<SandboxResult> {
    this.calls.push(command);
    return Promise.resolve(this.result);
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
    await expect(createTool().execute("ls", context)).rejects.toThrow(/必须是对象/);
  });

  it("拒绝空命令", async () => {
    await expect(createTool().execute({ command: "   " }, context)).rejects.toThrow(/command/);
  });

  it("拒绝超长命令", async () => {
    await expect(createTool().execute({ command: "x".repeat(10_001) }, context)).rejects.toThrow(/command/);
  });

  it("拒绝未知参数", async () => {
    await expect(createTool().execute({ command: "ls", shell: "zsh" }, context)).rejects.toThrow(/不支持参数/);
  });

  it("拒绝绝对路径的 workdir", async () => {
    await expect(createTool().execute({ command: "ls", workdir: "/etc" }, context)).rejects.toThrow(/相对/);
  });

  it("拒绝越出工作区的 workdir", async () => {
    await expect(createTool().execute({ command: "ls", workdir: "../.." }, context)).rejects.toThrow(/工作区内/);
  });

  it("拒绝非字符串 workdir", async () => {
    await expect(createTool().execute({ command: "ls", workdir: 1 }, context)).rejects.toThrow(/workdir/);
  });

  it("拒绝越界的 timeout_ms", async () => {
    await expect(createTool().execute({ command: "ls", timeout_ms: 10 }, context)).rejects.toThrow(/timeout_ms/);
    await expect(createTool().execute({ command: "ls", timeout_ms: 999_999 }, context)).rejects.toThrow(/timeout_ms/);
  });

  it("工作区根与临时目录必须是绝对路径", () => {
    expect(() => new TerminalTool({ workspaceRoot: "relative", sessionTempDir: tempDir })).toThrow(/绝对路径/);
    expect(() => new TerminalTool({ workspaceRoot: workspace, sessionTempDir: "relative" })).toThrow(/绝对路径/);
  });

  it("取消信号在执行前生效", async () => {
    const controller = new AbortController();
    controller.abort(new Error("用户取消"));
    await expect(createTool().execute({ command: "ls" }, { ...context, signal: controller.signal }))
      .rejects.toThrow("用户取消");
  });
});

describe("run_terminal 交给沙箱的请求", () => {
  it("默认在工作区根执行并注入 TMPDIR", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls -a" }, context);
    const call = sandbox.calls[0];
    expect(call?.command).toBe("ls -a");
    expect(call?.cwd).toBe(workspace);
    expect(call?.env.TMPDIR).toBe(tempDir);
    expect(call?.timeoutMs).toBe(120_000);
  });

  it("子目录 workdir 解析到工作区内", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls", workdir: "src/tools" }, context);
    expect(sandbox.calls[0]?.cwd).toBe(join(workspace, "src", "tools"));
  });

  it("传入的 timeout_ms 覆盖默认值", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls", timeout_ms: 5_000 }, context);
    expect(sandbox.calls[0]?.timeoutMs).toBe(5_000);
  });

  it("环境变量不含父进程凭证", async () => {
    const sandbox = new RecordingSandbox();
    await createTool(sandbox).execute({ command: "ls" }, context);
    expect(Object.keys(sandbox.calls[0]?.env ?? {})).not.toContain("TAVILY_API_KEY");
  });

  it("结果保留退出码、截断标记与沙箱类型", async () => {
    const sandbox = new RecordingSandbox();
    sandbox.result = { exitCode: 1, stdout: "", stderr: "Operation not permitted", truncated: true, timedOut: false, denialHint: "filesystem" };
    const result = await createTool(sandbox).execute({ command: "ls", workdir: "src" }, context);
    expect(result).toMatchObject({
      exitCode: 1,
      truncated: true,
      denialHint: "filesystem",
      sandbox: "seatbelt",
      workdir: "src",
    });
  });

  it("工作区根本身的 workdir 记为当前目录", async () => {
    const result = await createTool().execute({ command: "ls" }, context);
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
    const result = await tool.execute({ command: "echo 你好 > hello.txt && cat hello.txt" }, context);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("你好");
    expect(readFileSync(join(workspace, "hello.txt"), "utf8").trim()).toBe("你好");
    expect(result.sandbox).toBe("seatbelt");
  });

  it("越界写入失败并带出边界提示", async () => {
    const tool = new TerminalTool({ workspaceRoot: workspace, sessionTempDir: tempDir });
    const result = await tool.execute({ command: `echo 越界 > ${JSON.stringify(join(root, "leak.txt"))}` }, context);
    expect(result.exitCode).not.toBe(0);
    expect(result.denialHint).toBe("filesystem");
  });
});
