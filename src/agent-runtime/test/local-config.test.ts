import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime, createLocalConfig, clearEverythingData } from "../index.ts";

it("首次启动会创建完整的 .everything 基础目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-bootstrap-"));
  const home = join(root, ".everything");
  const defaultSystemPromptPath = join(root, "EVERYTHING.md");

  const runtime = createAgentRuntime({ home, defaultSystemPromptPath });
  try {
    await runtime.start();
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toMatchObject({
      models: { agent: {}, small: {} },
      maxTokens: 32_768, maxIterations: 100,
      modelContextWindow: 262_144, sessionRecall: { searchWindow: 10, entryTokenLimit: 8_192 },
      retrieval: { mode: "lexical_only", embedding: {} },
      tools: { getCurrentTimeEnabled: true, searchWebEnabled: false },
    });
    expect(await readFile(join(home, "EVERYTHING.md"), "utf8")).toContain("个人助理");
    expect((await stat(join(home, ".env"))).isFile()).toBe(true);
    await expect(runtime.getSettings()).resolves.toBeTypeOf("object");
    expect((await stat(join(home, "skills"))).isDirectory()).toBe(true);
    expect((await stat(join(home, "database", "state.db"))).isFile()).toBe(true);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("缺失配置时可创建，文件系统错误向调用方传播", async () => {
  const home = await mkdtemp(join(tmpdir(), "runtime-config-"));
  try {
    const envPath = join(home, ".env");
    const config = createLocalConfig({ home, defaultSystemPromptPath: join(home, "default.md") });
    await expect(config.readValues()).resolves.toBeTypeOf("object");
    await config.updateConfigFile({ EVERYTHING_AGENT_MODEL: "test" });
    await writeFile(envPath, 'EVERYTHING_MODEL="obsolete"\nUNRELATED="remove"\nEVERYTHING_SMALL_API_KEY="keep"\n');
    await config.updateSecretEnvFile({ EVERYTHING_AGENT_API_KEY: "secret" }, []);
    expect(await config.readValues()).toMatchObject({
      EVERYTHING_AGENT_MODEL: "test",
      EVERYTHING_AGENT_API_KEY: "secret",
      EVERYTHING_SMALL_API_KEY: "keep",
    });
    expect(await readFile(envPath, "utf8")).toBe(
      'EVERYTHING_AGENT_API_KEY="secret"\nEVERYTHING_SMALL_API_KEY="keep"\n',
    );
    expect(await readFile(join(home, "config.json"), "utf8")).not.toContain("secret");
    await expect(config.readSystemPrompt()).resolves.toContain("个人助理");
    await rm(join(home, "EVERYTHING.md"));
    await mkdir(join(home, "EVERYTHING.md"));
    await expect(config.readSystemPrompt()).rejects.toThrow();
    await expect(clearEverythingData(join(home, "missing"))).resolves.toBeUndefined();
    await writeFile(join(home, "file"), "text");
    await expect(clearEverythingData(join(home, "file"))).rejects.toThrow();
    // home 指向普通文件时，密钥与配置读写都应把文件系统错误抛给调用方。
    const invalid = createLocalConfig({ home: join(home, "file"), defaultSystemPromptPath: home });
    await expect(invalid.readValues()).rejects.toThrow();
    await expect(invalid.updateSecretEnvFile({}, [])).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});


it("重复初始化保留已有配置、密钥和提示词，并补齐缺失目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-preserve-"));
  const paths = { home: join(root, ".everything"), defaultSystemPromptPath: join(root, "default.md") };
  const envPath = join(paths.home, ".env");
  const config = createLocalConfig(paths);
  try {
    await writeFile(paths.defaultSystemPromptPath, "自定义模板");
    await config.initialize();
    expect(await config.readSystemPrompt()).toBe("自定义模板");
    await config.saveSystemPrompt("用户规则");
    await config.updateConfigFile({ EVERYTHING_AGENT_MODEL: "custom" });
    await writeFile(envPath, '# 用户注释\nEVERYTHING_AGENT_API_KEY="keep"\n');
    const before = await readFile(join(paths.home, "config.json"), "utf8");
    await rm(join(paths.home, "skills"), { recursive: true });
    await Promise.all([config.initialize(), config.initialize()]);
    expect(await config.readSystemPrompt()).toBe("用户规则\n");
    expect(await readFile(envPath, "utf8")).toBe('# 用户注释\nEVERYTHING_AGENT_API_KEY="keep"\n');
    expect(await readFile(join(paths.home, "config.json"), "utf8")).toBe(before);
    expect((await stat(join(paths.home, "skills"))).isDirectory()).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
