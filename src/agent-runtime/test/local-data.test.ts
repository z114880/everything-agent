import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { clearEverythingData } from "../index.ts";

describe("本地 Agent 数据清理", () => {
  it("删除数据库、会话附件和全部 trace，保留 .env、EVERYTHING.md、Skills 和 config.json", async () => {
    const home = await mkdtemp(join(tmpdir(), "everything-clear-"));
    await writeFile(join(home, ".env"), 'EVERYTHING_AGENT_API_KEY="keep"\n', "utf8");
    await writeFile(join(home, "EVERYTHING.md"), "保留的规则", "utf8");
    const configContent = '{"models":{"agent":{"model":"test-model"}}}\n';
    await writeFile(join(home, "config.json"), configContent, "utf8");
    await mkdir(join(home, "skills", "daily-plan"), { recursive: true });
    await writeFile(join(home, "skills", "daily-plan", "SKILL.md"), "技能", "utf8");
    await mkdir(join(home, "database"));
    await writeFile(join(home, "database", "state.db"), "database", "utf8");
    await writeFile(join(home, "database", "state.db-wal"), "wal", "utf8");
    await mkdir(join(home, "traces", "2026-09-03"), { recursive: true });
    await writeFile(join(home, "traces", "2026-09-03", "s1.jsonl"), "{}\n", "utf8");

    await clearEverythingData(home);

    expect((await readdir(home)).sort()).toEqual([".env", "EVERYTHING.md", "config.json", "skills"]);
    expect(await readFile(join(home, ".env"), "utf8")).toBe('EVERYTHING_AGENT_API_KEY="keep"\n');
    expect(await readFile(join(home, "config.json"), "utf8")).toBe(configContent);
    expect(await readFile(join(home, "EVERYTHING.md"), "utf8")).toBe("保留的规则");
    expect(await readFile(join(home, "skills", "daily-plan", "SKILL.md"), "utf8")).toBe("技能");
  });

  it("拒绝把文件系统根目录作为清理目标", async () => {
    await expect(clearEverythingData("/")).rejects.toThrow("拒绝清理文件系统根目录");
  });
});
