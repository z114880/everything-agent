import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { startEvaluation, closeEvaluation } from "./evaluation-service.ts";
import { startLocalAgent } from "./agent-service.ts";
import { createLocalApi } from "./local-api.ts";
import { assertWorkflowModule } from "./workflow-files.ts";

// 以下路径按构建产物 `dist-server/` 的布局解析：prod-server.js 位于 dist-server/web/server/。
const distWebDirectory = fileURLToPath(new URL("../../../dist-web/", import.meta.url));
const workflowDirectory = fileURLToPath(new URL("../../src/workflows/", import.meta.url));

const DEFAULT_PORT = 5173;
const DEFAULT_HOST = "127.0.0.1";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * 启动生产服务器：同时提供前端静态资源与本地 Agent/Workflow/Evaluation API。
 * 供构建产物内的入口脚本调用；数据目录沿用启动进程的当前目录或 `EVERYTHING_HOME`。
 */
export async function startProductionServer(): Promise<Server> {
  await startLocalAgent();
  await startEvaluation();
  const apiHandler = createLocalApi({
    workflowDirectory,
    workflowEditable: false,
    loadWorkflow: async (file) => assertWorkflowModule(await import(pathToFileURL(file).href)),
  });
  const server = createServer((request, response) => {
    void apiHandler(request, response, () => {
      void serveStatic(request, response);
    });
  });

  const port = readPort();
  const host = process.env.EVERYTHING_HOST ?? DEFAULT_HOST;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolveListen();
    });
  });
  console.log(`Everything Agent 已启动：http://${host}:${port}`);
  return server;
}

async function serveStatic(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(response, 405, "Method Not Allowed");
    return;
  }
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = normalize(join(distWebDirectory, relativePath));
  if (!filePath.startsWith(distWebDirectory)) {
    sendText(response, 403, "Forbidden");
    return;
  }

  let info;
  try {
    info = await stat(filePath);
  } catch {
    sendText(response, 404, "Not Found");
    return;
  }
  if (info.isDirectory()) {
    sendText(response, 404, "Not Found");
    return;
  }
  const body = await readFile(filePath);
  response.statusCode = 200;
  response.setHeader("Content-Type", CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream");
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(request.method === "HEAD" ? undefined : body);
}

function readPort(): number {
  const raw = process.env.EVERYTHING_PORT;
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("EVERYTHING_PORT 必须是 1-65535 的整数");
  }
  return port;
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(text);
}

// 直接运行本文件时启动服务器；被 import 时仅导出 startProductionServer。
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  startProductionServer().catch((error) => {
    console.error("生产服务器启动失败：", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void closeEvaluation().finally(() => process.exit(0));
    });
  }
}
