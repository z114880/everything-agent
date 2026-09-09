import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentRuntime, createLocalConfig, clearEverythingData } from "../index.ts";

it("首次启动会创建完整的 .everything 基础目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-bootstrap-"));
  const home = join(root, ".everything");
  const defaultSystemPromptPath = join(root, "EVERYTHING.md");
  await writeFile(defaultSystemPromptPath, "你是个人助理。\n", "utf8");
  const runtime = createAgentRuntime({ home, envPath: join(root, ".env"), defaultSystemPromptPath });
  try {
    await runtime.start();
    expect(JSON.parse(await readFile(join(home, "config.json"), "utf8"))).toMatchObject({
      models: { agent: {}, small: {} },
      retrieval: { mode: "lexical_only", embedding: {} },
      tools: { getCurrentTimeEnabled: true, searchWebEnabled: false },
    });
    expect(await readFile(join(home, "EVERYTHING.md"), "utf8")).toBe("你是个人助理。\n");
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
    const config = createLocalConfig({ home, envPath, defaultSystemPromptPath: join(home, "default.md") });
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
    await expect(config.readSystemPrompt()).rejects.toThrow();
    await mkdir(join(home, "EVERYTHING.md"));
    await expect(config.readSystemPrompt()).rejects.toThrow();
    const invalid = createLocalConfig({ home, envPath: home, defaultSystemPromptPath: home });
    await expect(invalid.readValues()).rejects.toThrow();
    await expect(invalid.updateSecretEnvFile({}, [])).rejects.toThrow();
    await expect(clearEverythingData(join(home, "missing"))).resolves.toBeUndefined();
    await writeFile(join(home, "file"), "text");
    await expect(clearEverythingData(join(home, "file"))).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});
