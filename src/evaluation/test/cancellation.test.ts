import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createEvaluationService, exampleEvaluationPlan } from "../index.ts";

it.each(["cancelled", "timed_out"] as const)("在模型请求挂起时终止进程：%s，保留部分 Trace 并清理凭证", async (status) => {
  const arrived = Promise.withResolvers<void>();
  const server = createServer((request) => { request.resume(); arrived.resolve(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("本地服务器地址无效");
  const home = await mkdtemp(join(tmpdir(), "evaluation-cancel-"));
  vi.stubEnv("EVALUATION_MODEL_API_KEY", "local-fixture-key");
  const service = createEvaluationService(home);
  let id: string | undefined;
  try {
    const plan = exampleEvaluationPlan(fileURLToPath(new URL("../../../", import.meta.url)));
    plan.repetitions = 1; plan.gate.minimumRepetitions = 1; plan.dataset.cases[0]!.critical = false;
    plan.timeoutMs = status === "timed_out" ? 1000 : 5000;
    plan.baseline.agent.baseUrl = plan.baseline.small.baseUrl = `http://127.0.0.1:${address.port}`;
    plan.candidate.agent.baseUrl = plan.candidate.small.baseUrl = plan.baseline.agent.baseUrl;
    id = await service.start(plan);
    await arrived.promise;
    if (status === "cancelled") expect(service.cancel(id)).toBe(true);
    await service.wait();
    const result = await service.get(id);
    expect(result.report?.decision).toBe("insufficient");
    expect(result.executions[0]?.status).toBe(status);
    expect(result.executions[0]?.evidence?.complete).toBe(false);
    expect(result.executions[0]?.evidence?.traces.flatMap((file) => file.records).some((record) => record.type === "run_started")).toBe(true);
    expect(await readFile(join(home, id, "executions/current-time-baseline-1/home/.env"), "utf8")).not.toContain("local-fixture-key");
  } finally {
    if (id) service.cancel(id);
    await service.wait();
    vi.unstubAllEnvs(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
}, 15000);
