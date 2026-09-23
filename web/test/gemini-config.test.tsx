// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ConfigPage } from "../src/pages/config/ConfigPage";

const api = vi.hoisted(() => ({ loadAgent: vi.fn(), saveAgentConfig: vi.fn() }));
vi.mock("../src/agent-api", async (original) => ({ ...await original<object>(), ...api }));
vi.mock("../src/lib/minimum-duration", () => ({ withMinimumDuration: (operation: () => unknown) => operation() }));
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  vi.clearAllMocks();
});

it("所有 Provider 按指定顺序展示，双模型与 Embedding 可分别保存 Gemini", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const connection = { provider: "anthropic", model: "test", baseUrl: "", keyConfigured: false, keyLast4: "" };
  const settings = {
    agentModel: connection, smallModel: connection, sessionSearchWindow: 5, sessionRecallEntryTokenLimit: 8192,
    sessionRecallTokenLimit: 65536, modelContextWindow: 262144, maxTokens: 32768, maxIterations: 100,
    retrievalMode: "lexical_only", embeddingProvider: "openai-compatible", embeddingBaseUrl: "", embeddingModel: "", embeddingMinimumSimilarity: 0.3,
    embeddingKeyConfigured: false, embeddingKeyLast4: "", embeddingIndex: { ready: false },
    sandbox: { workspaceRoot: "/tmp/workspace", kind: null, unavailableReason: "测试环境" }, limits: {},
  };
  api.loadAgent.mockResolvedValue({ settings });
  api.saveAgentConfig.mockImplementation(async (input) => ({ settings: { ...settings, ...input }, models: { agentModel: [], smallModel: [] } }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ConfigPage />));
  for (const label of ["Agent Model Provider", "Small Model Provider", "Embedding Provider"]) {
    const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    await act(async () => trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(options.map(item => item.textContent)).toEqual(["OpenAI Compatible", "Anthropic", "Google Gemini"]);
    expect(options[1]!.getAttribute("aria-disabled")).toBe(label === "Embedding Provider" ? "true" : null);
    const option = options.find(item => item.textContent === "Google Gemini");
    expect(option).toBeDefined();
    await act(async () => option!.click());
    expect(trigger.textContent).toContain("Google Gemini");
  }
  expect(container.querySelectorAll('input[placeholder="https://generativelanguage.googleapis.com/v1beta"]')).toHaveLength(3);
  const save = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("保存模型连接配置"))!;
  await act(async () => save.click());
  expect(api.saveAgentConfig).toHaveBeenLastCalledWith(expect.objectContaining({
    agentModel: expect.objectContaining({ provider: "gemini" }), smallModel: expect.objectContaining({ provider: "gemini" }),
  }));
  const retrievalSave = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("保存检索配置"))!;
  await act(async () => retrievalSave.click());
  expect(api.saveAgentConfig).toHaveBeenLastCalledWith(expect.objectContaining({ embeddingProvider: "gemini" }));
});
