import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/pages/config/ConfigPage.tsx", import.meta.url));
const tracePage = fileURLToPath(new URL("../src/pages/trace/TracePage.tsx", import.meta.url));

describe("全局数据清理入口", () => {
  it("只在配置页面展示全部数据清理按钮", async () => {
    expect(await readFile(configPage, "utf8")).toContain("清除全部数据");
    expect(await readFile(tracePage, "utf8")).not.toContain("清除全部数据");
  });

  it("清理范围与保留范围分成两行展示", async () => {
    expect(await readFile(configPage, "utf8")).toMatch(
      /索引和全部 Traces。\s*<br \/>\s*保留 <code>\.everything\/EVERYTHING\.md<\/code>/,
    );
  });
});
