import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 把发布包放到项目以外启动，避免意外借用开发目录中的依赖和个人数据。
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const packageDirectory = resolve(process.argv[2] ?? join(projectRoot, "release", `everything-agent-${process.platform}-${process.arch}`));
const temporary = await mkdtemp(join(tmpdir(), "everything-package-check-"));
let child;
let exited;
try {
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  assert.equal(manifest.scripts.start, "node dist-server/web/server/prod-server.js");
  const isolatedPackage = join(temporary, "package");
  // 只复制发布所需文件，验证不读取用户曾在发布目录产生的 .everything。
  await cp(packageDirectory, isolatedPackage, {
    recursive: true,
    filter: (source) => ![".everything", ".evaluations", ".langfuse"].some((name) => source === join(packageDirectory, name)),
  });
  const port = await availablePort();
  const environment = { ...process.env, EVERYTHING_HOME: join(temporary, "data"), EVERYTHING_HOST: "127.0.0.1", EVERYTHING_PORT: String(port) };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("LANGFUSE_") || key === "NODE_PATH" || key === "NODE_OPTIONS") delete environment[key];
  }
  child = spawn(process.execPath, ["dist-server/web/server/prod-server.js"], {
    cwd: isolatedPackage, env: environment, stdio: ["ignore", "pipe", "pipe"],
  });
  exited = once(child, "exit");
  let output = "";
  await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => finish(new Error(`生产服务启动超时：${output}`)), 20000);
    function finish(error) {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) reject(error); else resolveReady();
    }
    function onData(chunk) {
      output += chunk.toString();
      if (output.includes("Everything Agent 已启动：")) finish();
    }
    function onError(error) { finish(error); }
    function onExit(code) { finish(new Error(`生产服务提前退出（${code}）：${output}`)); }
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, options) {
    return fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
  }
  const page = await request("/");
  assert.equal(page.status, 200);
  const html = await page.text();
  const asset = html.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(asset, "首页应引用前端构建资源");
  assert.equal((await request(asset)).status, 200);
  assert.equal((await request("/api/local-agent")).status, 200);
  const workflow = await (await request("/api/local-workflow")).json();
  assert.equal(workflow.editable, false);
  assert.ok(workflow.selectedFile.endsWith(".js"));
  assert.equal((await request("/api/local-workflow", { method: "PUT", body: "{}" })).status, 403);
  const execution = await request("/api/local-workflow/run", {
    method: "POST", body: JSON.stringify({ file: workflow.selectedFile, input: "准备今天的工作" }),
  });
  assert.equal(execution.status, 200);
  const events = (await execution.text()).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.kind === "node_end"));
  assert.equal(events.at(-1).result.status, "completed");
  assert.ok((await stat(join(temporary, "data", ".everything", "database", "state.db"))).isFile());
  console.log("发布包验证通过：项目外独立启动、静态资源、Agent 初始化、工作流只读与真实执行、独立数据目录。");
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await exited; } finally { clearTimeout(force); }
  }
  await rm(temporary, { recursive: true, force: true });
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  const port = probe.address().port;
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return port;
}
