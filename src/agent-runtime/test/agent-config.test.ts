import { describe, expect, it } from "vitest";
import { parseEnv, updateEnvText } from "../index.ts";

describe("本地 Agent 模型配置", () => {
  it("解析引号、export 与行尾注释", () => {
    expect(parseEnv('export EVERYTHING_MODEL="model-a"\nOPENAI_API_KEY=secret # local\n')).toEqual({
      EVERYTHING_MODEL: "model-a",
      OPENAI_API_KEY: "secret",
    });
  });

  it("更新目标字段时保留注释和无关配置，并可显式清除密钥", () => {
    const source = '# 用户配置\nOTHER="keep"\nOPENAI_API_KEY="old"\n';
    expect(updateEnvText(source, {
      EVERYTHING_PROVIDER: "openai-compatible",
      EVERYTHING_MODEL: "model-b",
    }, ["OPENAI_API_KEY"])).toBe(
      '# 用户配置\nOTHER="keep"\nEVERYTHING_PROVIDER="openai-compatible"\nEVERYTHING_MODEL="model-b"\n',
    );
  });
});

it("解析单引号及未转义双引号，并合并重复字段", () => {
  expect(parseEnv("A='hello'\nB=\"bad\\q\"\nEMPTY=\n# comment")).toEqual({ A: "hello", B: "bad\\q", EMPTY: "" });
  expect(updateEnvText("A=old\nA=duplicate\nB=keep", { A: "new" })).toBe('A="new"\nB=keep\n');
});
