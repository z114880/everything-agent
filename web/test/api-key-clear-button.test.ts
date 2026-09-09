import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/pages/config/ConfigPage.tsx", import.meta.url));
const agentApi = fileURLToPath(new URL("../src/agent-api.ts", import.meta.url));

describe("API Key 清除入口", () => {
  it("使用 shadcn AlertDialog 二次确认后立即清除密钥", async () => {
    const page = await readFile(configPage, "utf8");

    expect(page).toContain("<AlertDialog>");
    expect(page).toContain("<AlertDialogAction onClick={onConfirm}>");
    expect(page).toContain("清除 API Key");
    expect(page).toContain('variant="destructive-outline"');
    expect(page).not.toContain("window.confirm");
    expect(await readFile(agentApi, "utf8")).toContain("/config/clear-api-key");
  });

  it("检索配置的保存与清除按钮使用相同尺寸", async () => {
    const page = await readFile(configPage, "utf8");
    const embeddingDialog = page.slice(page.indexOf("function EmbeddingKeyClearDialog"));

    expect(embeddingDialog).toContain('<Button variant="destructive-outline">');
    expect(embeddingDialog).not.toContain('<Button variant="destructive-outline" size="sm">');
  });
});
