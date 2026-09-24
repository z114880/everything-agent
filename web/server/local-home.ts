import { join, resolve } from "node:path";

/**
 * 本地数据与运行时资源的工作根目录。
 * 默认使用启动进程的当前目录，可用 `EVERYTHING_HOME` 显式覆盖，
 * 使开发（项目根）与生产（产物根）都从用户运行 `npm start` 的位置定位 `.everything`。
 */
export function resolveLocalHome(): string {
  return process.env.EVERYTHING_HOME ? resolve(process.env.EVERYTHING_HOME) : process.cwd();
}

/** `.everything` 数据目录：配置、密钥、数据库与记忆都保存在这里。 */
export function resolveEverythingHome(): string {
  return join(resolveLocalHome(), ".everything");
}
