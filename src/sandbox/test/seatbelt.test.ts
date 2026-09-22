import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSandboxEnv, buildSeatbeltProfile, SeatbeltSandbox } from "../index.ts";
import type { SandboxPolicy } from "../index.ts";
import { probeSeatbelt, reportSkippedRealSandbox } from "./sandbox-probe.ts";

// 真实边界用例需要 seatbelt 能建立，先探测能力再决定是否运行。
const seatbelt = await probeSeatbelt();
reportSkippedRealSandbox(seatbelt);

describe("Seatbelt 策略生成", () => {
  const policy: SandboxPolicy = {
    workspaceRoot: "/tmp/ws",
    writableRoots: ["/tmp/session"],
    denyWrite: ["/tmp/ws/.git"],
    denyRead: ["/tmp/ws/secret"],
    allowNetwork: false,
  };

  it("拒写规则排在允许写入之后，否则会被静默覆盖", () => {
    const profile = buildSeatbeltProfile(policy);
    const allowIndex = profile.indexOf("(allow file-write*");
    const denyIndex = profile.indexOf("(deny file-write*");
    expect(allowIndex).toBeGreaterThanOrEqual(0);
    expect(denyIndex).toBeGreaterThan(allowIndex);
  });

  it("拒读规则排在允许读取之后", () => {
    const profile = buildSeatbeltProfile(policy);
    expect(profile.indexOf("(deny file-read*")).toBeGreaterThan(profile.indexOf("(allow file-read*"));
  });

  it("默认关闭网络，放行时改写为 allow", () => {
    expect(buildSeatbeltProfile(policy)).toContain("(deny network*)");
    expect(buildSeatbeltProfile({ ...policy, allowNetwork: true })).toContain("(allow network*)");
  });

  it("可写根与额外可写目录写入同一条规则", () => {
    const profile = buildSeatbeltProfile(policy);
    const line = profile.split("\n").find((item) => item.startsWith("(allow file-write*"));
    expect(line).toContain("/tmp/ws");
    expect(line).toContain("/tmp/session");
  });

  it("路径中的引号与反斜杠被转义", () => {
    const profile = buildSeatbeltProfile({ ...policy, workspaceRoot: '/tmp/a"b\\c' });
    expect(profile).toContain('\\"b\\\\c');
  });
});

describe.skipIf(!seatbelt.usable)("Seatbelt 实际边界", () => {
  let workspace = "";
  let outside = "";
  let sandbox: SeatbeltSandbox;

  beforeAll(() => {
    const root = mkdtempSync(join(tmpdir(), "everything-sandbox-"));
    workspace = join(root, "workspace");
    outside = join(root, "outside");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(workspace, ".git", "HEAD"), "ref: refs/heads/master\n");
    sandbox = new SeatbeltSandbox({
      workspaceRoot: workspace,
      writableRoots: [],
      denyWrite: [join(workspace, ".git")],
      denyRead: [],
      allowNetwork: false,
    });
  });

  afterAll(() => {
    if (workspace !== "") rmSync(join(workspace, ".."), { recursive: true, force: true });
  });

  const run = (command: string, timeoutMs = 20_000) =>
    sandbox.run({ command, cwd: workspace, timeoutMs, env: buildSandboxEnv() });

  it("工作区内可以写入", async () => {
    const result = await run("echo 内容 > note.txt");
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(workspace, "note.txt"), "utf8").trim()).toBe("内容");
  });

  it("工作区外写入被拒", async () => {
    const result = await run(`echo 越界 > ${JSON.stringify(join(outside, "leak.txt"))}`);
    expect(result.exitCode).not.toBe(0);
    expect(result.denialHint).toBe("filesystem");
  });

  it("经由符号链接的越界写入同样被拒", async () => {
    symlinkSync(outside, join(workspace, "link"), "dir");
    const result = await run("echo 越界 > link/leak.txt");
    expect(result.exitCode).not.toBe(0);
    expect(result.denialHint).toBe("filesystem");
  });

  it("`.git` 目录不可写", async () => {
    const result = await run("echo 篡改 > .git/HEAD");
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(join(workspace, ".git", "HEAD"), "utf8")).toContain("refs/heads/master");
  });

  it("默认切断出站网络", async () => {
    const result = await run("curl -s -m 5 -o /dev/null https://example.com");
    expect(result.exitCode).not.toBe(0);
  });

  it("子进程环境不含父进程的凭证", async () => {
    const result = await sandbox.run({
      command: "env",
      cwd: workspace,
      timeoutMs: 20_000,
      env: buildSandboxEnv({}, { PATH: process.env.PATH, HOME: process.env.HOME, TAVILY_API_KEY: "机密值" }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("机密值");
    expect(result.stdout).not.toContain("TAVILY_API_KEY");
  });

  it("超时会终止命令并标记 timedOut", async () => {
    const result = await run("sleep 10", 500);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("取消信号会中止执行", async () => {
    const controller = new AbortController();
    const pending = sandbox.run({
      command: "sleep 10",
      cwd: workspace,
      timeoutMs: 20_000,
      env: buildSandboxEnv(),
      signal: controller.signal,
    });
    controller.abort(new Error("用户取消"));
    await expect(pending).rejects.toThrow("用户取消");
  });

  it("超长输出保留首尾并标记截断", async () => {
    const result = await run("seq 1 200000");
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("已省略");
    expect(result.stdout.length).toBeLessThan(80_000);
  });
});
