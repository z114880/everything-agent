import { describe, expect, it } from "vitest";
import { buildSandboxEnv, createSandbox, detectSandbox } from "../index.ts";
import type { SandboxPolicy } from "../index.ts";

const policy: SandboxPolicy = {
  workspaceRoot: "/tmp/everything-workspace",
  writableRoots: [],
  denyWrite: [],
  denyRead: [],
  allowNetwork: false,
};

describe("沙箱探测", () => {
  it("macOS 上有 sandbox-exec 时使用 Seatbelt", () => {
    const result = detectSandbox({ platform: "darwin", hasExecutable: () => true });
    expect(result).toEqual({ available: true, kind: "seatbelt" });
  });

  it("macOS 上缺少 sandbox-exec 时不可用", () => {
    const result = detectSandbox({ platform: "darwin", hasExecutable: () => false });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("sandbox-exec");
  });

  it("Linux 上有 bwrap 时使用 bubblewrap", () => {
    const result = detectSandbox({ platform: "linux", hasExecutable: (name) => name === "bwrap" });
    expect(result).toEqual({ available: true, kind: "bubblewrap" });
  });

  it("Linux 上缺少 bwrap 时给出安装提示", () => {
    const result = detectSandbox({ platform: "linux", hasExecutable: () => false });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("bubblewrap");
  });

  it("原生 Windows 不提供降级档位，引导改用 WSL2", () => {
    const result = detectSandbox({ platform: "win32", hasExecutable: () => true });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("WSL2");
  });

  it("其余平台一律判定为不可用", () => {
    const result = detectSandbox({ platform: "freebsd", hasExecutable: () => true });
    expect(result.available).toBe(false);
    if (!result.available) expect(result.reason).toContain("freebsd");
  });

  it("使用真实环境探测时返回布尔可用性", () => {
    expect(typeof detectSandbox().available).toBe("boolean");
  });

  it("非绝对路径的可执行文件按 PATH 查找", () => {
    expect(typeof detectSandbox({ platform: "linux" }).available).toBe("boolean");
  });
});

describe("沙箱创建", () => {
  it("按平台创建 Seatbelt 实现并声明强制的边界", () => {
    const sandbox = createSandbox(policy, { platform: "darwin", hasExecutable: () => true });
    expect(sandbox.kind).toBe("seatbelt");
    expect(sandbox.enforces).toEqual({ filesystem: true, network: true });
  });

  it("按平台创建 bubblewrap 实现", () => {
    const sandbox = createSandbox(policy, { platform: "linux", hasExecutable: () => true });
    expect(sandbox.kind).toBe("bubblewrap");
    expect(sandbox.enforces).toEqual({ filesystem: true, network: true });
  });

  it("探测不通过时报错而不是降级执行", () => {
    expect(() => createSandbox(policy, { platform: "win32", hasExecutable: () => true }))
      .toThrow(/沙箱不可用/);
  });
});

describe("沙箱环境变量", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "/usr/bin",
    HOME: "/Users/tester",
    TAVILY_API_KEY: "机密",
    ANTHROPIC_AUTH_TOKEN: "机密",
    DATABASE_URL: "机密",
    LANG: "zh_CN.UTF-8",
    EMPTY: "",
  };

  it("只透传白名单变量，凭证一律不进子进程", () => {
    const env = buildSandboxEnv({}, source);
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/Users/tester");
    expect(env.LANG).toBe("zh_CN.UTF-8");
    expect(Object.keys(env)).not.toContain("TAVILY_API_KEY");
    expect(Object.keys(env)).not.toContain("ANTHROPIC_AUTH_TOKEN");
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
  });

  it("空值变量不透传", () => {
    expect(Object.keys(buildSandboxEnv({}, source))).not.toContain("EMPTY");
  });

  it("固定关闭彩色与交互式渲染", () => {
    const env = buildSandboxEnv({}, source);
    expect(env.TERM).toBe("dumb");
    expect(env.NO_COLOR).toBe("1");
  });

  it("覆盖项优先于继承值", () => {
    const env = buildSandboxEnv({ TMPDIR: "/tmp/session", TERM: "xterm" }, source);
    expect(env.TMPDIR).toBe("/tmp/session");
    expect(env.TERM).toBe("xterm");
  });

  it("默认从当前进程环境读取", () => {
    expect(typeof buildSandboxEnv().TERM).toBe("string");
  });
});
