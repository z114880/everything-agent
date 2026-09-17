import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { createEvaluationService } from "../../src/evaluation/index.ts";

const evaluationProjectRoot = fileURLToPath(new URL("../../", import.meta.url));
/** 评估数据与日常 Agent 数据分目录，普通清理不会删除实验记录。 */
export const evaluationService = createEvaluationService(join(evaluationProjectRoot, ".evaluations"), join(evaluationProjectRoot, ".everything"), { sourceRoot: evaluationProjectRoot });
