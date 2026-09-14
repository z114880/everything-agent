import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildBubblewrapArgs, buildSandboxEnv, BubblewrapSandbox } from "../index.ts";
import type { PathKind, SandboxPolicy } from "../index.ts";

const policy: SandboxPolicy = {
  workspaceRoot: "/srv/ws",
  writableRoots: ["/srv/session"],
  denyWrite: ["/srv/ws/.git"],
  denyRead: ["/home/tester/.ssh", "/home/tester/.netrc"],
  allowNetwork: false,
};

/** 返回挂载目标首次出现的下标；`--tmpfs` 只带目标，其余标志是「源 目标」两个参数。 */
function indexOfMount(args: readonly string[], flag: string, target: string): number {
  const offset = flag === "--tmpfs" ? 1 : 2;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + offset] === target) return index;
  }
  return -1;
}

describe("bubblewrap 参数组装", () => {
  const pathKind = (path: string): PathKind => (path.endsWith(".ssh") ? "directory" : "file");

  it("全盘只读挂载排在最前，作为其余挂载的底", () => {
    const args = buildBubblewrapArgs(policy, pathKind);
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
  });

  it("可写目录的读写挂载覆盖只读底层", () => {
    const args = buildBubblewrapArgs(policy, pathKind);
    expect(indexOfMount(args, "--bind", "/srv/ws")).toBeGreaterThan(0);
    expect(indexOfMount(args, "--bind", "/srv/session")).toBeGreaterThan(0);
  });

  it("拒写目录的只读挂载排在可写挂载之后", () => {
    const args = buildBubblewrapArgs(policy, pathKind);
    expect(indexOfMount(args, "--ro-bind", "/srv/ws/.git")).toBeGreaterThan(indexOfMount(args, "--bind", "/srv/ws"));
  });

  it("拒读目录盖为空 tmpfs，拒读文件盖为 /dev/null", () => {
    const args = buildBubblewrapArgs(policy, pathKind);
    expect(args).toContain("--tmpfs");
    expect(indexOfMount(args, "--tmpfs", "/home/tester/.ssh")).toBeGreaterThan(0);
    expect(args.join(" ")).toContain("--ro-bind /dev/null /home/tester/.netrc");
  });

  it("默认切断网络命名空间，放行时不再隔离", () => {
    expect(buildBubblewrapArgs(policy, pathKind)).toContain("--unshare-net");
    expect(buildBubblewrapArgs({ ...policy, allowNetwork: true }, pathKind)).not.toContain("--unshare-net");
  });

  it("固定启用进程隔离与父进程绑定", () => {
    const args = buildBubblewrapArgs(policy, pathKind);
    expect(args).toContain("--unshare-pid");
    expect(args).toContain("--new-session");
    expect(args).toContain("--die-with-parent");
  });

  it("不存在的拒读路径被跳过，避免挂载失败拖垮整次执行", () => {
    const args = buildBubblewrapArgs({ ...policy, denyRead: ["/nonexistent-path-for-test"] }, () => "missing");
    expect(args.join(" ")).not.toContain("/nonexistent-path-for-test");
  });

  it("默认形态判定不依赖注入即可工作", () => {
    expect(buildBubblewrapArgs({ ...policy, denyRead: ["/nonexistent-path-for-test"] })).toContain("--unshare-net");
  });

  // 真实边界只能在装有 bwrap 的 Linux 上验证；此处覆盖缺少 bwrap 时的失败路径。
  it.skipIf(process.platform === "linux")("缺少 bwrap 时执行直接失败，不会静默降级", async () => {
    const sandbox = new BubblewrapSandbox({ ...policy, workspaceRoot: tmpdir() });
    await expect(sandbox.run({
      command: "echo hi",
      cwd: tmpdir(),
      timeoutMs: 5_000,
      env: buildSandboxEnv(),
    })).rejects.toThrow();
  });
});
