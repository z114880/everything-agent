import { fileURLToPath, URL } from "node:url";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { runGraph } from "../src/engine/src/index.js";
import type { Graph, StateRecord } from "../src/engine/src/index.js";

const workflowDirectory = fileURLToPath(new URL("../src/engine/workflows/", import.meta.url));
const apiPrefix = "/api/local-workflow";

interface WorkflowModule {
  graph: Graph<StateRecord>;
  createInitialState?: (input: string) => StateRecord | Promise<StateRecord>;
  maxSteps?: number;
}

/** 在 Vite 开发服务器中桥接浏览器和本地 Engine，不把执行代码打进浏览器。 */
function localEnginePlugin(): Plugin {
  return {
    name: "everything-agent-local-engine",
    // 编辑器保存本地工作流时不刷新页面；下一次 describe/run 会加载带新时间戳的模块。
    handleHotUpdate(context) {
      if (context.file.startsWith(workflowDirectory) && context.file.endsWith(".ts")) return [];
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        const pathname = requestUrl.pathname;
        if (!pathname.startsWith(apiPrefix)) return next();

        try {
          if ((request.method === "PUT" || request.method === "POST") && !isLocalOrigin(request.headers.origin)) {
            return sendJson(response, 403, { error: "本地工作流接口只接受本机页面请求" });
          }
          if (request.method === "GET" && pathname === apiPrefix) {
            const files = await listWorkflowFiles();
            const selectedFile = await resolveWorkflowFile(requestUrl.searchParams.get("file"), files);
            const workflowFile = join(workflowDirectory, selectedFile);
            const source = await readFile(workflowFile, "utf8");
            const workflow = await loadWorkflow(server, workflowFile);
            return sendJson(response, 200, {
              files,
              selectedFile,
              source,
              workflow: toWorkflow(workflow.graph),
            });
          }

          if (request.method === "PUT" && pathname === apiPrefix) {
            const body = await readJsonBody(request);
            const files = await listWorkflowFiles();
            const selectedFile = await resolveWorkflowFile(body.file, files);
            const workflowFile = join(workflowDirectory, selectedFile);
            if (typeof body.source !== "string" || body.source.length > 200_000) {
              throw new Error("工作流源码必须是小于 200KB 的字符串");
            }
            await writeFile(workflowFile, body.source, "utf8");
            const workflow = await loadWorkflow(server, workflowFile);
            return sendJson(response, 200, { workflow: toWorkflow(workflow.graph) });
          }

          if (request.method === "POST" && pathname === `${apiPrefix}/run`) {
            const body = await readJsonBody(request);
            const files = await listWorkflowFiles();
            const selectedFile = await resolveWorkflowFile(body.file, files);
            const workflowFile = join(workflowDirectory, selectedFile);
            const input = typeof body.input === "string" ? body.input : "";
            const workflow = await loadWorkflow(server, workflowFile);
            const initialState = workflow.createInitialState
              ? await workflow.createInitialState(input)
              : { message: input };

            response.statusCode = 200;
            response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
            response.setHeader("Cache-Control", "no-store");
            const startedAt = performance.now();
            const result = await runGraph(workflow.graph, initialState, {
              maxSteps: workflow.maxSteps,
              observer(kind, event) {
                response.write(`${JSON.stringify({ type: "event", kind, event })}\n`);
              },
            });
            response.end(`${JSON.stringify({
              type: "result",
              result: { ...result, totalMs: Math.round(performance.now() - startedAt) },
            })}\n`);
            return;
          }

          return sendJson(response, 404, { error: "未知的本地工作流接口" });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (response.headersSent) {
            response.end(`${JSON.stringify({ type: "error", error: message })}\n`);
          } else {
            sendJson(response, 400, { error: message });
          }
        }
      });
    },
  };
}

async function loadWorkflow(server: ViteDevServer, workflowFile: string): Promise<WorkflowModule> {
  // 查询参数让每次保存后的源码都作为新模块加载，避免执行旧的 SSR 缓存。
  const moduleUrl = `/@fs/${workflowFile}?t=${Date.now()}`;
  const loaded = await server.ssrLoadModule(moduleUrl) as Partial<WorkflowModule>;
  if (!loaded.graph || typeof loaded.graph.describe !== "function") {
    throw new Error("本地文件必须导出 graph（Graph 实例）");
  }
  if (loaded.createInitialState && typeof loaded.createInitialState !== "function") {
    throw new Error("createInitialState 必须是函数");
  }
  if (loaded.maxSteps !== undefined && (!Number.isInteger(loaded.maxSteps) || loaded.maxSteps < 1)) {
    throw new Error("maxSteps 必须是正整数");
  }
  return loaded as WorkflowModule;
}

async function listWorkflowFiles(): Promise<string[]> {
  const entries = await readdir(workflowDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) throw new Error("src/engine/workflows 中没有可用的 TypeScript 工作流");
  return files;
}

async function resolveWorkflowFile(value: unknown, files: readonly string[]): Promise<string> {
  if (value === null || value === undefined || value === "") return files[0]!;
  if (typeof value !== "string" || !files.includes(value)) {
    throw new Error("工作流文件不存在或不在 src/engine/workflows 目录中");
  }
  return value;
}

function toWorkflow(graph: Graph<StateRecord>) {
  const description = graph.describe();
  return {
    name: description.name,
    nodes: description.nodes.map((value) => ({
      id: value.name,
      label: value.name,
      kind: value.kind,
      maxVisits: value.maxVisits,
    })),
    edges: description.edges,
  };
}

async function readJsonBody(request: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of request) {
    text += String(chunk);
    if (text.length > 250_000) throw new Error("请求内容过大");
  }
  const value: unknown = text ? JSON.parse(text) : {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请求体必须是对象");
  return value as Record<string, unknown>;
}

function sendJson(response: import("node:http").ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react(), tailwindcss(), localEnginePlugin()],
  build: {
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
  },
});
