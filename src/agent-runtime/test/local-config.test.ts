import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createLocalConfig, clearEverythingData } from "../index.ts";

it("缺失配置时可创建，文件系统错误向调用方传播", async () => {
  const home = await mkdtemp(join(tmpdir(), "runtime-config-"));
  try {
    const config = createLocalConfig({ home, envPath: join(home, "config", ".env"), defaultSystemPromptPath: join(home, "default.md") });
    await expect(config.readEnvValues()).resolves.toBeTypeOf("object");
    await config.updateEnvFile({ EVERYTHING_MODEL: "test" }, []);
    expect((await config.readEnvValues()).EVERYTHING_MODEL).toBe("test");
    await expect(config.readSystemPrompt()).rejects.toThrow();
    await mkdir(join(home, "EVERYTHING.md"));
    await expect(config.readSystemPrompt()).rejects.toThrow();
    const invalid = createLocalConfig({ home, envPath: home, defaultSystemPromptPath: home });
    await expect(invalid.readEnvValues()).rejects.toThrow();
    await expect(invalid.updateEnvFile({}, [])).rejects.toThrow();
    await expect(clearEverythingData(join(home, "missing"))).resolves.toBeUndefined();
    await writeFile(join(home, "file"), "text");
    await expect(clearEverythingData(join(home, "file"))).rejects.toThrow();
  } finally { await rm(home, { recursive: true, force: true }); }
});
