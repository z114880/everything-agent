import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
const memoryPage = fileURLToPath(new URL("../src/components/MemoryPage.tsx", import.meta.url));

describe("System Prompt 编辑入口", () => {
  it("不在配置页展示，并保留在 Procedural Memory 页面", async () => {
    expect(await readFile(configPage, "utf8")).not.toContain("System Prompt");
    expect(await readFile(memoryPage, "utf8")).toContain("System Prompt");
  });
});
