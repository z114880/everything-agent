import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearEverythingData } from "../index.ts";

describe("本地 Agent 数据清理", () => {
  it("删除数据库、会话附件和全部 trace，仅保留 EVERYTHING.md", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-clear-"));
    await writeFile(join(home, "EVERYTHING.md"), "保留的规则", "utf8");
    await mkdir(join(home, "database"));
    await writeFile(join(home, "database", "state.db"), "database", "utf8");
    await writeFile(join(home, "database", "state.db-wal"), "wal", "utf8");
    await mkdir(join(home, "traces", "2026-09-03"), { recursive: true });
    await writeFile(join(home, "traces", "2026-09-03", "s1.jsonl"), "{}\n", "utf8");

    await clearEverythingData(home);

    expect(await readdir(home)).toEqual(["EVERYTHING.md"]);
    expect(await readFile(join(home, "EVERYTHING.md"), "utf8")).toBe("保留的规则");
  });

  it("拒绝把文件系统根目录作为清理目标", async () => {
    await expect(clearEverythingData("/")).rejects.toThrow("拒绝清理文件系统根目录");
  });
});
