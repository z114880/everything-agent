import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
const styleSheet = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("配置页布局", () => {
  it("分组展示模型连接与运行参数，并在窄屏改为单列", async () => {
    const page = await readFile(configPage, "utf8");
    const styles = await readFile(styleSheet, "utf8");

    expect(page).toContain("模型连接");
    expect(page).toContain("运行参数");
    expect(page).toContain('className="config-storage-warning"');
    expect(styles).toContain(".config-page-header .config-storage-warning { color: #b42318; font-weight: 650; }");
    expect(styles).toContain(".config-settings-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(styles).toContain(".config-settings-grid { grid-template-columns: 1fr; }");
  });
});
