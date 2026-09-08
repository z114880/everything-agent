import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillStore } from "../../index.ts";

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function setup(): Promise<{ home: string; store: SkillStore }> {
  const home = await mkdtemp(join(tmpdir(), "everything-skills-"));
  homes.push(home);
  return { home, store: new SkillStore(home) };
}

describe("SkillStore", () => {
  it("新建、读取、重命名和删除 Skill，并保留重命名目录中的资源", async () => {
    const { home, store } = await setup();
    expect(await store.list()).toEqual([]);
    const created = await store.save({ name: "meeting-prep", description: "准备会议", instructions: "先读取议程。" });
    expect(created).toMatchObject({ name: "meeting-prep", description: "准备会议", instructions: "先读取议程。", path: ".everything/skills/meeting-prep/SKILL.md" });
    await writeFile(join(home, "skills", "meeting-prep", "template.md"), "模板");

    const renamed = await store.save({ originalName: "meeting-prep", name: "meeting-brief", description: "生成会前简报", instructions: "先读取议程，再列出风险。" });
    expect(renamed.name).toBe("meeting-brief");
    expect(await readFile(join(home, "skills", "meeting-brief", "template.md"), "utf8")).toBe("模板");
    expect(await readFile(join(home, "skills", "meeting-brief", "SKILL.md"), "utf8")).toContain('description: "生成会前简报"');

    await store.delete("meeting-brief");
    expect(await store.list()).toEqual([]);
  });

  it("生成不含正文的发现目录，并拒绝越界名称和损坏文件", async () => {
    const { home, store } = await setup();
    await store.save({ name: "daily-plan", description: "规划当天任务", instructions: "私人执行细节" });
    const catalog = await store.catalog();
    expect(catalog).toContain("- daily-plan: 规划当天任务");
    expect(catalog).toContain("read_skill");
    expect(catalog).not.toContain("私人执行细节");
    await expect(store.read("../secret")).rejects.toThrow("Skill name");
    await expect(store.save({ name: "Invalid Name", description: "无效", instructions: "无效" })).rejects.toThrow("Skill name");

    await mkdir(join(home, "skills", "broken"), { recursive: true });
    await writeFile(join(home, "skills", "broken", "SKILL.md"), "没有 frontmatter");
    await expect(store.list()).rejects.toThrow("frontmatter");
  });
});
