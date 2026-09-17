import { resolve } from "node:path";
import { createEvaluationService } from "./index.ts";

// 预留与页面一致的自动化入口；尚不配置任何 CI 工作流。
const service = createEvaluationService(resolve(".evaluations"));
const ids = process.argv.slice(2);
const id = await service.start(ids.length ? ids : undefined);
process.once("SIGINT", () => service.cancel(id));
await service.wait();
const run = await service.get(id);
console.log(JSON.stringify({ id, status: run.status, report: run.report, error: run.error }, null, 2));
process.exitCode = run.report.decision === "passed" ? 0 : run.report.decision === "failed" ? 1 : 2;
