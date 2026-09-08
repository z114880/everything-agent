import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { LocalToolRegistry, SkillStore } from "../../index.ts";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

it("read_skill 按需返回正文，并发布不含正文的加载事件", async () => {
  const home = await mkdtemp(join(tmpdir(), "read-skill-"));
  homes.push(home);
  const store = new SkillStore(home);
  await store.save({ name: "daily-plan", description: "规划当天任务", instructions: "先列出三件要事" });
  const registry = new LocalToolRegistry(undefined, undefined, undefined, store);
  const notify = vi.fn();

  expect(registry.schemas()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "read_skill" })]));
  await expect(registry.execute("read_skill", { name: "daily-plan" }, notify, {
    signal: undefined, deadline: null, iteration: 2, toolUseId: "tool-1",
  })).resolves.toMatchObject({ name: "daily-plan", instructions: "先列出三件要事" });
  expect(notify).toHaveBeenCalledWith("skill_loaded", expect.objectContaining({
    skill: "daily-plan", instructionLength: 7, iteration: 2, toolCallId: "tool-1",
  }));
  expect(JSON.stringify(notify.mock.calls)).not.toContain("先列出三件要事");
});
