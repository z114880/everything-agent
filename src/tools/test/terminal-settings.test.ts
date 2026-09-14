import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalConfig } from "../../agent-runtime/local-config.ts";
import { detectSandbox } from "../../sandbox/index.ts";
import { createToolSettings } from "../tool-settings.ts";

let home = "";
let workspace = "";
let settings: ReturnType<typeof createToolSettings>;

/** 当前平台能否建立沙箱，决定「启用成功」的用例是否适用。 */
const sandboxAvailable = detectSandbox().available;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "everything-tool-settings-"));
  workspace = join(home, "workspace");
  mkdtempSync(join(home, "seed-"));
  const config = createLocalConfig({ home, defaultSystemPromptPath: join(home, "missing.md") });
  await config.initialize();
  settings = createToolSettings(config);
  rmSync(workspace, { recursive: true, force: true });
});

afterEach(() => {
  if (home !== "") rmSync(home, { recursive: true, force: true });
});

const base = { getCurrentTimeEnabled: true, searchWebEnabled: false };

describe("终端工具设置", () => {
  it("默认关闭且未配置工作区", async () => {
    const loaded = await settings.load();
    expect(loaded.terminalEnabled).toBe(false);
    expect(loaded.terminalWorkspaceRoot).toBe("");
  });

  it("启用前必须配置工作区根目录", async () => {
    await expect(settings.save({ ...base, terminalEnabled: true })).rejects.toThrow(/工作区根目录/);
  });

  it("拒绝相对路径的工作区根目录", async () => {
    await expect(settings.save({ ...base, terminalWorkspaceRoot: "./workspace" })).rejects.toThrow(/绝对路径/);
  });

  it("拒绝不存在的工作区根目录", async () => {
    await expect(settings.save({ ...base, terminalEnabled: true, terminalWorkspaceRoot: workspace }))
      .rejects.toThrow(/不存在/);
  });

  it("拒绝指向文件的工作区根目录", async () => {
    const file = join(home, "not-a-directory.txt");
    writeFileSync(file, "x");
    await expect(settings.save({ ...base, terminalEnabled: true, terminalWorkspaceRoot: file }))
      .rejects.toThrow(/必须是目录/);
  });

  it("拒绝超长的工作区根目录", async () => {
    await expect(settings.save({ ...base, terminalWorkspaceRoot: `/${"x".repeat(4_001)}` }))
      .rejects.toThrow(/4000/);
  });

  it("未启用时可以只保存工作区根目录", async () => {
    mkdtempSync(join(home, "ws-"));
    const saved = await settings.save({ ...base, terminalWorkspaceRoot: home });
    expect(saved.terminalWorkspaceRoot).toBe(home);
    expect(saved.terminalEnabled).toBe(false);
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

  it.skipIf(!sandboxAvailable)("配置齐备时可以启用并在目录中标记为已启用", async () => {
    const saved = await settings.save({ ...base, terminalEnabled: true, terminalWorkspaceRoot: home });
    expect(saved.terminalEnabled).toBe(true);
    const catalog = await settings.publicCatalog();
    const descriptor = catalog.tools.find((tool) => tool.name === "run_terminal");
    expect(descriptor?.enabled).toBe(true);
    expect(descriptor?.configured).toBe(true);
  });

  it.skipIf(!sandboxAvailable)("再次保存时沿用已存的工作区根目录", async () => {
    await settings.save({ ...base, terminalEnabled: true, terminalWorkspaceRoot: home });
    const saved = await settings.save(base);
    expect(saved.terminalEnabled).toBe(true);
    expect(saved.terminalWorkspaceRoot).toBe(home);
  });
});
