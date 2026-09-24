import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 启动已构建的生产服务器；构建动作由 `npm run build:prod` 单独负责。
const serverPath = fileURLToPath(new URL("../dist-server/web/server/prod-server.js", import.meta.url));

if (!existsSync(serverPath)) {
  console.error("尚未构建产物，请先执行：npm run build:prod");
  process.exit(1);
}

const child = spawn(process.execPath, [serverPath], { stdio: "inherit" });
child.on("error", (error) => {
  console.error("启动生产服务器失败：", error.message);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
