import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = fileURLToPath(new URL("../src/components/ToolsPage.tsx", import.meta.url));
const api = fileURLToPath(new URL("../src/agent-api.ts", import.meta.url));

describe("Tools 页面", () => {
  it("展示工具目录、固定工具状态和 Tavily 配置，但不包含调用历史或 MCP", async () => {
    const source = await readFile(page, "utf8");
    expect(source).toContain('title="Tools"');
    expect(source).toContain("固定内置能力");
    expect(source).toContain("Tavily API Key");
    expect(source).toContain('role="switch"');
    expect(source).not.toContain("调用历史");
    expect(source).not.toContain("MCP");
  });

  it("通过独立接口读取和保存脱敏工具配置", async () => {
    const source = await readFile(api, "utf8");
    expect(source).toContain('requestJson(`${endpoint}/tools`)');
    expect(source).toContain('requestJson(`${endpoint}/tools`, {');
    expect(source).toContain("keyLast4");
  });
});
