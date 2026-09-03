import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import type { Plugin, ViteDevServer } from "vite";
import { runGraph } from "../../src/engine/src/index.js";
import type { Graph, StateRecord } from "../../src/engine/src/index.js";
import {
  AgentConfigError,
  loadAgentBootstrap,
  handleMemoryAction,
  loadTraceDashboard,
  runLocalAgent,
  saveAgentSettings,
  saveSystemPrompt,
} from "./agent-service.js";

const workflowDirectory = fileURLToPath(new URL("../../src/workflows/", import.meta.url));
const workflowApiPrefix = "/api/local-workflow";
const agentApiPrefix = "/api/local-agent";

interface WorkflowModule {
  graph: Graph<StateRecord>;
  createInitialState?: (input: string) => StateRecord | Promise<StateRecord>;
  maxSteps?: number;
}

/** 创建仅供本地开发使用的 Engine API 插件。 */
export function localEnginePlugin(): Plugin {
  return {
    name: "everything-agent-local-engine",
    // 编辑器保存本地工作流时不刷新页面；下一次 describe/run 会加载带新时间戳的模块。
    handleHotUpdate(context) {
      if (context.file.startsWith(workflowDirectory) && context.file.endsWith(".ts")) return [];
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        void handleLocalApiRequest(server, request, response, next);
      });
    },
  };
}

async function handleLocalApiRequest(
  server: ViteDevServer,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  next: (error?: unknown) => void,
): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  const pathname = requestUrl.pathname;
  if (!pathname.startsWith(workflowApiPrefix) && !pathname.startsWith(agentApiPrefix)) {
    next();
    return;
  }

  try {
    if ((request.method === "PUT" || request.method === "POST") && !isLocalOrigin(request.headers.origin)) {
      sendJson(response, 403, { error: "本地工作流接口只接受本机页面请求" });
      return;
    }
    if (pathname.startsWith(workflowApiPrefix)) {
      await handleWorkflowRequest(server, request, response, requestUrl);
      return;
    }
    await handleAgentRequest(request, response, pathname);
  } catch (error) {
    sendRequestError(response, error);
  }
}

async function handleWorkflowRequest(
  server: ViteDevServer,
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  requestUrl: URL,
): Promise<void> {
  const pathname = requestUrl.pathname;
  if (request.method === "GET" && pathname === workflowApiPrefix) {
    const files = await listWorkflowFiles();
    const selectedFile = resolveWorkflowFile(requestUrl.searchParams.get("file"), files);
    const workflowFile = join(workflowDirectory, selectedFile);
    const source = await readFile(workflowFile, "utf8");
    const workflow = await loadWorkflow(server, workflowFile);
    sendJson(response, 200, {
      files,
      selectedFile,
      source,
      workflow: toWorkflow(workflow.graph),
    });
    return;
  }

  if (request.method === "PUT" && pathname === workflowApiPrefix) {
    const body = await readJsonBody(request);
    const files = await listWorkflowFiles();
    const selectedFile = resolveWorkflowFile(body.file, files);
    const workflowFile = join(workflowDirectory, selectedFile);
    if (typeof body.source !== "string" || body.source.length > 200_000) {
      throw new Error("工作流源码必须是小于 200KB 的字符串");
    }
    await writeFile(workflowFile, body.source, "utf8");
    const workflow = await loadWorkflow(server, workflowFile);
    sendJson(response, 200, { workflow: toWorkflow(workflow.graph) });
    return;
  }

  if (request.method === "POST" && pathname === `${workflowApiPrefix}/run`) {
    const body = await readJsonBody(request);
    const files = await listWorkflowFiles();
    const selectedFile = resolveWorkflowFile(body.file, files);
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

  sendJson(response, 404, { error: "未知的本地工作流接口" });
}

async function handleAgentRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  pathname: string,
): Promise<void> {
  if (request.method === "GET" && pathname === agentApiPrefix) {
    sendJson(response, 200, await loadAgentBootstrap());
    return;
  }

  if (request.method === "PUT" && pathname === `${agentApiPrefix}/config`) {
    const body = await readJsonBody(request);
    sendJson(response, 200, { ok: true, ...await saveAgentSettings(body) });
    return;
  }

  if (request.method === "PUT" && pathname === `${agentApiPrefix}/system-prompt`) {
    const body = await readJsonBody(request);
    sendJson(response, 200, { ok: true, systemPrompt: await saveSystemPrompt(body) });
    return;
  }

  if (request.method === "GET" && pathname === `${agentApiPrefix}/memory`) {
    sendJson(response, 200, await handleMemoryAction({ action: "bootstrap" }));
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/memory`) {
    sendJson(response, 200, { ok: true, result: await handleMemoryAction(await readJsonBody(request)) });
    return;
  }

  if (request.method === "GET" && pathname === `${agentApiPrefix}/traces`) {
    sendJson(response, 200, await loadTraceDashboard());
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/run`) {
    const body = await readJsonBody(request);
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new Error("客户端已停止本轮运行"));
    });
    response.statusCode = 200;
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const result = await runLocalAgent(body, (kind, event) => {
      if (!response.destroyed) response.write(`${JSON.stringify({ type: "event", kind, event })}\n`);
    }, controller.signal);
    if (!response.destroyed) response.end(`${JSON.stringify({ type: "result", result })}\n`);
    return;
  }

  sendJson(response, 404, { error: "未知的本地工作流接口" });
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
  if (files.length === 0) throw new Error("src/workflows 中没有可用的 TypeScript 工作流");
  return files;
}

function resolveWorkflowFile(value: unknown, files: readonly string[]): string {
  if (value === null || value === undefined || value === "") return files[0]!;
  if (typeof value !== "string" || !files.includes(value)) {
    throw new Error("工作流文件不存在或不在 src/workflows 目录中");
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

function sendRequestError(response: import("node:http").ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const details = error instanceof AgentConfigError
    ? { error: message, canForce: error.canForce }
    : { error: message };
  if (response.headersSent) {
    if (!response.destroyed) response.end(`${JSON.stringify({ type: "error", error: message })}\n`);
  } else {
    sendJson(response, 400, details);
  }
}

function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
