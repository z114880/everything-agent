import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Node 原生 TypeScript 运行时", () => {
  it("无需 dist 即可加载包公开入口", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", "await import('everything-agent')"],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.status, result.stderr).toBe(0);
  });
});
