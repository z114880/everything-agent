import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
const tracePage = fileURLToPath(new URL("../src/components/TracePage.tsx", import.meta.url));

describe("全局数据清理入口", () => {
  it("只在配置页面展示一键清理按钮", async () => {
    expect(await readFile(configPage, "utf8")).toContain("一键清理");
    expect(await readFile(tracePage, "utf8")).not.toContain("一键清理");
  });
});
