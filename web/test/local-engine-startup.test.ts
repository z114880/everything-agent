import { expect, it, vi } from "vitest";
import { createServer } from "vite";
import { localEnginePlugin } from "../server/local-engine-plugin.ts";

vi.mock("../server/evaluation-service.ts", () => ({ startEvaluation: vi.fn(async () => {}), closeEvaluation: vi.fn(async () => {}), evaluationDashboard: vi.fn(), evaluationDatasets: vi.fn(), evaluationWebhookHeaders: vi.fn(), evaluationAction: vi.fn() }));

const { startLocalAgent } = vi.hoisted(() => ({ startLocalAgent: vi.fn(async () => {}) }));
vi.mock("../server/agent-service.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("../server/agent-service.ts")>(),
  startLocalAgent,
}));

it("开发服务器接受请求前初始化本地 Agent，无需先打开页面", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, plugins: [localEnginePlugin()] });
  try {
    expect(startLocalAgent).toHaveBeenCalledOnce();
  } finally { await server.close(); }
});

it("开发服务器读取项目工作流源码并开放编辑能力", async () => {
  const server = await createServer({ configFile: false, server: { port: 0, host: "127.0.0.1" }, plugins: [localEnginePlugin()] });
  try {
    await server.listen();
    const address = server.httpServer!.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/api/local-workflow`);
    expect(response.status).toBe(200);
    const loaded = await response.json();
    expect(loaded.editable).toBe(true);
    expect(loaded.selectedFile).toMatch(/\.ts$/);
    expect(loaded.source).toContain('../engine/src/index.ts');
    expect(loaded.workflow.nodes.length).toBeGreaterThan(0);
  } finally { await server.close(); }
});
