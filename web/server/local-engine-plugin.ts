import { fileURLToPath, URL } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { startEvaluation, closeEvaluation } from "./evaluation-service.ts";
import { startLocalAgent } from "./agent-service.ts";
import { createLocalApi } from "./local-api.ts";
import { assertWorkflowModule } from "./workflow-files.ts";
import type { WorkflowModule } from "./workflow-files.ts";

// 开发环境直接编辑项目源码，生产环境运行对应构建产物。
const workflowDirectory = fileURLToPath(new URL("../../src/workflows/", import.meta.url));

/** 创建仅供本地开发使用的 Engine API 插件；生产服务器改用 prod-server。 */
export function localEnginePlugin(): Plugin {
  return {
    name: "everything-agent-local-engine",
    async closeBundle() { await closeEvaluation(); },
    async configureServer(server) {
      await startLocalAgent();
      await startEvaluation();
      server.middlewares.use(createLocalApi({
        workflowDirectory,
        workflowEditable: true,
        loadWorkflow: (workflowFile) => loadWorkflowWithVite(server, workflowFile),
      }));
    },
  };
}

async function loadWorkflowWithVite(server: ViteDevServer, workflowFile: string): Promise<WorkflowModule> {
  // 查询参数让每次保存后的源码都作为新模块加载，避免执行旧的 SSR 缓存。
  const moduleUrl = `/@fs/${workflowFile}?t=${Date.now()}`;
  const loaded = await server.ssrLoadModule(moduleUrl) as unknown;
  return assertWorkflowModule(loaded);
}
