import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("配置页布局", () => {
  it("用卡片分组模型、检索与运行参数，并在窄屏改为单列", async () => {
    const page = await readFile(configPage, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(page).toContain("模型连接");
    expect(page).toContain("Memory Retrieval");
    expect(page).toContain("运行参数");
    expect(page).toContain("<Card");
    expect(page).toContain("<Alert");
    expect(styles).toContain(".config-grid { display: grid; grid-template-columns:");
    expect(styles).toContain(".config-grid { grid-template-columns: 1fr; }");
  });
});
