import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = fileURLToPath(new URL("../src/components/ToolsPage.tsx", import.meta.url));
const api = fileURLToPath(new URL("../src/agent-api.ts", import.meta.url));
const styles = fileURLToPath(new URL("../src/index.css", import.meta.url));

describe("Tools 页面", () => {
  it("从工具卡片的配置状态打开 Tavily 弹窗，但不包含独立配置卡或调用历史", async () => {
    const source = await readFile(page, "utf8");
    expect(source).toContain('title="Tools"');
    expect(source).toContain("固定内置能力");
    expect(source).toContain("Tavily API Key");
    expect(source).toContain("tavilyDialogOpen");
    expect(source).toContain('className="tool-configure"');
    expect(source).not.toContain("tavily-config-card");
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

  it("点击工具开关立即保存，并且页面不再提供统一保存按钮", async () => {
    const source = await readFile(page, "utf8");
    expect(source).toContain("handleGetCurrentTimeToggle");
    expect(source).toContain("handleSearchWebToggle");
    expect(source).toContain("nextGetCurrentTimeEnabled: enabled");
    expect(source).toContain("nextSearchWebEnabled: enabled");
    expect(source).toContain('className="tools-toast"');
    expect(source).not.toContain('className="tools-message"');
    expect(source).not.toContain('saving ? "正在保存…" : "保存配置"');
  });

  it("Toast 在页面顶部水平居中，并带有完整的进入和退出动画", async () => {
    const source = await readFile(styles, "utf8");
    expect(source).toMatch(/\.tools-toast\s*\{[^}]*left:\s*50%/s);
    expect(source).toContain("animation: tools-toast-lifecycle");
    expect(source).toContain("@keyframes tools-toast-lifecycle");
  });
});
