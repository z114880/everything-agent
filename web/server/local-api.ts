import { join } from "node:path";
import { runGraph } from "../../src/engine/src/index.ts";
import { evaluationDashboard, evaluationDatasets, evaluationWebhookHeaders, evaluationAction } from "./evaluation-service.ts";
import {
  AgentConfigError,
  subscribeBackgroundEvents,
  clearModelApiKey,
  clearEmbeddingApiKey,
  clearLocalAgentData,
  loadAgentBootstrap,
  handleMemoryAction,
  loadTraceDashboard,
  localAgentDatabasePath,
  listPendingApprovals,
  runLocalAgent,
  settleApproval,
  saveAgentSettings,
  resetRuntimeSettings,
  rebuildEmbeddingIndex,
  cancelEmbeddingIndexRebuild,
  saveSystemPrompt,
  startLocalAgent,
  loadSkills,
  saveSkill,
  deleteSkill,
  loadTools,
  saveTools,
} from "./agent-service.ts";
import { executeDatabaseSql, loadDatabaseDashboard } from "./database-service.ts";
import {
  listWorkflowFiles,
  readWorkflowSource,
  resolveWorkflowFile,
  toWorkflow,
  writeWorkflowSource,
} from "./workflow-files.ts";
import type { WorkflowModule } from "./workflow-files.ts";

const workflowApiPrefix = "/api/local-workflow";
const agentApiPrefix = "/api/local-agent";

/** 由调用方注入的工作流加载器：开发环境走 Vite SSR，生产环境直接导入构建产物。 */
export type WorkflowLoader = (workflowFile: string) => Promise<WorkflowModule>;

export interface LocalApiOptions {
  /** 开发源码或生产构建后的工作流目录。 */
  workflowDirectory: string;
  /** 仅开发服务器开启源码编辑；默认只读。 */
  workflowEditable?: boolean;
  /** 工作流模块加载器，用于 describe 与 run。 */
  loadWorkflow: WorkflowLoader;
}

/**
 * 创建本地 Agent / Workflow / Evaluation 的 HTTP 处理器。
 * 与 Vite 解耦，开发插件与生产服务器共用同一套路由与校验。
 */
export function createLocalApi(options: LocalApiOptions): (
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  next: (error?: unknown) => void,
) => Promise<void> {
  const workflowDirectory = options.workflowDirectory;

  return async function localApiHandler(request, response, next) {
    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    const pathname = requestUrl.pathname;
    if (!pathname.startsWith(workflowApiPrefix) && !pathname.startsWith(agentApiPrefix) && !pathname.startsWith("/api/evaluation")) {
      next();
      return;
    }

    try {
      if (["PUT", "POST", "DELETE"].includes(request.method ?? "") && !isLocalOrigin(request.headers.origin)) {
        sendJson(response, 403, { error: "本地工作流接口只接受本机页面请求" });
        return;
      }
      if (pathname.startsWith("/api/evaluation")) {
        await handleEvaluationRequest(request, response, pathname);
        return;
      }
      if (pathname.startsWith(workflowApiPrefix)) {
        await handleWorkflowRequest(request, response, requestUrl, workflowDirectory, options.loadWorkflow, options.workflowEditable === true);
        return;
      }
      await handleAgentRequest(request, response, pathname);
    } catch (error) {
      sendRequestError(response, error);
    }
  };
}

async function handleEvaluationRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  pathname: string,
): Promise<void> {
  if (request.method === "GET" && pathname === "/api/evaluation") sendJson(response, 200, evaluationDashboard());
  else if (request.method === "GET" && pathname === "/api/evaluation/datasets") sendJson(response, 200, await evaluationDatasets());
  else if (request.method === "POST" && pathname === "/api/evaluation/webhook-headers") sendJson(response, 200, evaluationWebhookHeaders());
  else if (request.method === "POST" && pathname === "/api/evaluation") sendJson(response, 200, await evaluationAction(await readJsonBody(request)));
  else sendJson(response, 404, { error: "未知评估接口" });
}

async function handleWorkflowRequest(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  requestUrl: URL,
  workflowDirectory: string,
  loadWorkflow: WorkflowLoader,
  editable: boolean,
): Promise<void> {
  const pathname = requestUrl.pathname;
  if (request.method === "GET" && pathname === workflowApiPrefix) {
    const files = await listWorkflowFiles(workflowDirectory, editable ? ".ts" : ".js");
    const selectedFile = resolveWorkflowFile(requestUrl.searchParams.get("file"), files);
    const source = await readWorkflowSource(workflowDirectory, selectedFile);
    const workflow = await loadWorkflow(join(workflowDirectory, selectedFile));
    sendJson(response, 200, {
      editable,
      files,
      selectedFile,
      source,
      workflow: toWorkflow(workflow.graph),
    });
    return;
  }

  if (request.method === "PUT" && pathname === workflowApiPrefix) {
    if (!editable) {
      sendJson(response, 403, { error: "生产环境不支持编辑工作流" });
      return;
    }
    const body = await readJsonBody(request);
    const files = await listWorkflowFiles(workflowDirectory, editable ? ".ts" : ".js");
    const selectedFile = resolveWorkflowFile(body.file, files);
    await writeWorkflowSource(workflowDirectory, selectedFile, body.source);
    const workflow = await loadWorkflow(join(workflowDirectory, selectedFile));
    sendJson(response, 200, { workflow: toWorkflow(workflow.graph) });
    return;
  }

  if (request.method === "POST" && pathname === `${workflowApiPrefix}/run`) {
    const body = await readJsonBody(request);
    const files = await listWorkflowFiles(workflowDirectory, editable ? ".ts" : ".js");
    const selectedFile = resolveWorkflowFile(body.file, files);
    const input = typeof body.input === "string" ? body.input : "";
    const workflow = await loadWorkflow(join(workflowDirectory, selectedFile));
    const initialState = workflow.createInitialState
      ? await workflow.createInitialState(input)
      : { message: input };

    response.statusCode = 200;
    response.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    const startedAt = performance.now();
    const result = await runGraph(workflow.graph, initialState, {
      ...(workflow.maxSteps === undefined ? {} : { maxSteps: workflow.maxSteps }),
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
  if (request.method === "GET" && pathname === `${agentApiPrefix}/background-events`) {
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    response.flushHeaders();
    const unsubscribe = subscribeBackgroundEvents((kind, event) => {
      if (!response.destroyed) response.write(`data: ${JSON.stringify({ kind, event })}\n\n`);
    });
    response.on("close", unsubscribe);
    return;
  }
  if (request.method === "GET" && pathname === agentApiPrefix) {
    sendJson(response, 200, await loadAgentBootstrap());
    return;
  }

  if (request.method === "PUT" && pathname === `${agentApiPrefix}/config`) {
    const body = await readJsonBody(request);
    sendJson(response, 200, { ok: true, ...await saveAgentSettings(body) });
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/config/reset-runtime`) {
    sendJson(response, 200, { ok: true, ...await resetRuntimeSettings() });
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/config/rebuild-embeddings`) {
    sendJson(response, 200, { ok: true, ...await rebuildEmbeddingIndex() });
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/config/cancel-embedding-rebuild`) {
    sendJson(response, 200, { ok: true, ...cancelEmbeddingIndexRebuild() });
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/config/clear-api-key`) {
    sendJson(response, 200, { ok: true, ...await clearModelApiKey(await readJsonBody(request)) });
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/config/clear-embedding-api-key`) {
    sendJson(response, 200, { ok: true, ...await clearEmbeddingApiKey() });
    return;
  }

  if (request.method === "PUT" && pathname === `${agentApiPrefix}/system-prompt`) {
    const body = await readJsonBody(request);
    sendJson(response, 200, { ok: true, systemPrompt: await saveSystemPrompt(body) });
    return;
  }

  if (request.method === "GET" && pathname === `${agentApiPrefix}/skills`) {
    sendJson(response, 200, { skills: await loadSkills() });
    return;
  }

  if (request.method === "PUT" && pathname === `${agentApiPrefix}/skills`) {
    sendJson(response, 200, { ok: true, skill: await saveSkill(await readJsonBody(request)) });
    return;
  }

  if (request.method === "DELETE" && pathname === `${agentApiPrefix}/skills`) {
    await deleteSkill(await readJsonBody(request));
    sendJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && pathname === `${agentApiPrefix}/tools`) {
    sendJson(response, 200, await loadTools());
    return;
  }

  if (request.method === "PUT" && pathname === `${agentApiPrefix}/tools`) {
    sendJson(response, 200, { ok: true, ...await saveTools(await readJsonBody(request)) });
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
    const query = new URL(request.url ?? "/", "http://localhost").searchParams;
    sendJson(response, 200, await loadTraceDashboard({ ...(query.get("cursor") ? { cursor: query.get("cursor")! } : {}), ...(query.get("runId") ? { runId: query.get("runId")! } : {}) }));
    return;
  }

  if (request.method === "GET" && pathname === `${agentApiPrefix}/database`) {
    await startLocalAgent();
    sendJson(response, 200, loadDatabaseDashboard(localAgentDatabasePath));
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/database/query`) {
    await startLocalAgent();
    const body = await readJsonBody(request);
    sendJson(response, 200, executeDatabaseSql(localAgentDatabasePath, body.sql, body.confirmation));
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/clear-data`) {
    sendJson(response, 200, { ok: true, ...await clearLocalAgentData(await readJsonBody(request)) });
    return;
  }

  if (request.method === "POST" && pathname === `${agentApiPrefix}/approval`) {
    sendJson(response, 200, settleApproval(await readJsonBody(request)));
    return;
  }

  if (request.method === "GET" && pathname === `${agentApiPrefix}/approval`) {
    sendJson(response, 200, { pending: listPendingApprovals() });
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
