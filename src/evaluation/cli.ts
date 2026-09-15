import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createEvaluationService } from "./index.ts";

const [planFile, directory = ".evaluations"] = process.argv.slice(2);
if (!planFile) throw new Error("用法：pnpm run evaluate <实验 JSON> [评估目录]");
const service = createEvaluationService(resolve(directory));
const id = await service.start(JSON.parse(await readFile(resolve(planFile), "utf8")));
process.once("SIGINT", () => service.cancel(id));
await service.wait();
const experiment = await service.get(id);
console.log(JSON.stringify({ id, report: experiment.report, error: experiment.error }, null, 2));
process.exitCode = experiment.report?.decision === "passed" ? 0 : experiment.report?.decision === "failed" ? 1 : 2;
