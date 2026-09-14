import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { BubblewrapSandbox, BUBBLEWRAP_COMMAND } from "./bubblewrap.ts";
import { SeatbeltSandbox, SANDBOX_EXEC_PATH } from "./seatbelt.ts";
import type { Sandbox, SandboxKind, SandboxPolicy } from "./types.ts";

/** 探测结果；不可用时给出可直接展示给用户的中文原因。 */
export type SandboxAvailability =
  | { available: true; kind: SandboxKind }
  | { available: false; reason: string };

/** 探测依赖的外部条件，测试通过它覆盖各平台分支。 */
export interface SandboxDetectionOptions {
  platform?: NodeJS.Platform;
  hasExecutable?: (name: string) => boolean;
}

/**
 * 判断当前环境能否提供内核强制的沙箱。
 *
 * 探测不到就没有终端能力：这里不返回「无沙箱」档位，避免同一份代码在某些
 * 平台上静默失去保护。
 */
export function detectSandbox(options: SandboxDetectionOptions = {}): SandboxAvailability {
  const platform = options.platform ?? process.platform;
  const hasExecutable = options.hasExecutable ?? defaultHasExecutable;
  if (platform === "darwin") {
    if (hasExecutable(SANDBOX_EXEC_PATH)) return { available: true, kind: "seatbelt" };
    return { available: false, reason: `未找到 ${SANDBOX_EXEC_PATH}，无法在此 macOS 上建立沙箱` };
  }
  if (platform === "linux") {
    if (hasExecutable(BUBBLEWRAP_COMMAND)) return { available: true, kind: "bubblewrap" };
    return { available: false, reason: "未安装 bubblewrap，请先安装后重试（Debian/Ubuntu：sudo apt install bubblewrap）" };
  }
  if (platform === "win32") {
    return { available: false, reason: "原生 Windows 没有可用的内核沙箱，请在 WSL2 中运行 Everything Agent" };
  }
  return { available: false, reason: `平台 ${platform} 暂不支持沙箱` };
}

/** 按当前平台创建沙箱；探测不通过时直接报错，不降级为无保护执行。 */
export function createSandbox(policy: SandboxPolicy, options: SandboxDetectionOptions = {}): Sandbox {
  const availability = detectSandbox(options);
  if (!availability.available) throw new Error(`沙箱不可用：${availability.reason}`);
  return availability.kind === "seatbelt" ? new SeatbeltSandbox(policy) : new BubblewrapSandbox(policy);
}

/** 绝对路径直接判断存在性，其余名称按 PATH 查找。 */
function defaultHasExecutable(name: string): boolean {
  if (isAbsolute(name)) return existsSync(name);
  const paths = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  return paths.some((entry) => existsSync(join(entry, name)));
}
