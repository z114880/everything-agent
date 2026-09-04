import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
const agentApi = fileURLToPath(new URL("../src/agent-api.ts", import.meta.url));

describe("API Key 清除入口", () => {
  it("使用带二次确认的独立按钮立即清除密钥", async () => {
    const page = await readFile(configPage, "utf8");

    expect(page).toContain("window.confirm");
    expect(page).toContain("清除 API Key");
    expect(page).toContain('className="danger-ghost"');
    expect(page.indexOf("恢复运行默认值")).toBeLessThan(page.lastIndexOf("清除 API Key"));
    expect(await readFile(agentApi, "utf8")).toContain("/config/clear-api-key");
  });
});
