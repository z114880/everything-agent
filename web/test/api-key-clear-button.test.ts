import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const configPage = fileURLToPath(new URL("../src/components/ConfigPage.tsx", import.meta.url));
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
});
