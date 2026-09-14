import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkspaceRoot } from "../../agent-runtime/configuration/schema.ts";
import { createLocalConfig } from "../../agent-runtime/local-config.ts";
import { detectSandbox } from "../../sandbox/index.ts";
import { createToolSettings } from "../tool-settings.ts";

let home = "";
let config: ReturnType<typeof createLocalConfig>;
let settings: ReturnType<typeof createToolSettings>;

/** 当前平台能否建立沙箱，决定「启用成功」的用例是否适用。 */
const sandboxAvailable = detectSandbox().available;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "everything-tool-settings-"));
  config = createLocalConfig({ home, defaultSystemPromptPath: join(home, "missing.md") });
  await config.initialize();
  settings = createToolSettings(config);
});

afterEach(() => {
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

const base = { getCurrentTimeEnabled: true, searchWebEnabled: false };

/** 模拟配置页面在 Sandbox 区域保存工作区根目录。 */
async function configureWorkspace(path: string): Promise<void> {
  await config.updateConfigFile({ EVERYTHING_SANDBOX_WORKSPACE_ROOT: path });
}

describe("Sandbox 工作区校验", () => {
  it("空值表示尚未配置", () => {
    expect(parseWorkspaceRoot("")).toBe("");
    expect(parseWorkspaceRoot(undefined)).toBe("");
    expect(parseWorkspaceRoot("   ")).toBe("");
  });

  it("接受已存在目录的绝对路径", () => {
    expect(parseWorkspaceRoot(home)).toBe(home);
  });

  it("拒绝相对路径", () => {
    expect(() => parseWorkspaceRoot("./workspace")).toThrow(/绝对路径/);
  });

  it("拒绝不存在的目录", () => {
    expect(() => parseWorkspaceRoot(join(home, "missing"))).toThrow(/不存在/);
  });

  it("拒绝指向文件的路径", () => {
    const file = join(home, "not-a-directory.txt");
    writeFileSync(file, "x");
    expect(() => parseWorkspaceRoot(file)).toThrow(/必须是目录/);
  });

  it("拒绝超长路径", () => {
    expect(() => parseWorkspaceRoot(`/${"x".repeat(4_001)}`)).toThrow(/4000/);
  });
});

describe("终端工具设置", () => {
  it("默认关闭，且工作区读自 Sandbox 配置", async () => {
    const loaded = await settings.load();
    expect(loaded.terminalEnabled).toBe(false);
    expect(loaded.terminalWorkspaceRoot).toBe("");
  });

  it("Sandbox 未配置工作区时无法启用，并指向配置页面", async () => {
    await expect(settings.save({ ...base, terminalEnabled: true })).rejects.toThrow(/配置页面/);
  });

  it("读取 Sandbox 区域保存的工作区", async () => {
    await configureWorkspace(home);
    expect((await settings.load()).terminalWorkspaceRoot).toBe(home);
  });

  it("公开目录始终报告沙箱状态", async () => {
    const catalog = await settings.publicCatalog();
    expect(catalog.tools.some((tool) => tool.name === "run_terminal")).toBe(true);
    if (sandboxAvailable) {
      expect(catalog.terminal.sandboxKind).not.toBeNull();
      expect(catalog.terminal.unavailableReason).toBeNull();
    } else {
      expect(catalog.terminal.sandboxKind).toBeNull();
      expect(catalog.terminal.unavailableReason).not.toBeNull();
    }
  });

  it.skipIf(!sandboxAvailable)("Sandbox 配置就绪后可以启用", async () => {
    await configureWorkspace(home);
    const saved = await settings.save({ ...base, terminalEnabled: true });
    expect(saved.terminalEnabled).toBe(true);
    const descriptor = (await settings.publicCatalog()).tools.find((tool) => tool.name === "run_terminal");
    expect(descriptor?.enabled).toBe(true);
    expect(descriptor?.configured).toBe(true);
  });

  it.skipIf(!sandboxAvailable)("保存其他工具开关时保留终端启用状态", async () => {
    await configureWorkspace(home);
    await settings.save({ ...base, terminalEnabled: true });
    expect((await settings.save(base)).terminalEnabled).toBe(true);
  });
});
