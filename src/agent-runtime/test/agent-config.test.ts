import { describe, expect, it } from "vitest";
import { parseEnv, updateEnvText } from "../index.ts";

describe("本地 Agent 模型配置", () => {
  it("解析引号、export 与行尾注释", () => {
    expect(parseEnv('export EVERYTHING_AGENT_API_KEY="agent-secret"\nTAVILY_API_KEY=tool-secret # local\n')).toEqual({
      EVERYTHING_AGENT_API_KEY: "agent-secret",
      TAVILY_API_KEY: "tool-secret",
    });
  });

  it("更新目标字段时保留注释和无关配置，并可显式清除密钥", () => {
    const source = '# 本地密钥\nOTHER="keep"\nEVERYTHING_AGENT_API_KEY="old"\n';
    expect(updateEnvText(source, {
      TAVILY_API_KEY: "new",
    }, ["EVERYTHING_AGENT_API_KEY"])).toBe(
      '# 本地密钥\nOTHER="keep"\nTAVILY_API_KEY="new"\n',
    );
  });
});

it("解析单引号及未转义双引号，并合并重复字段", () => {
  expect(parseEnv("A='hello'\nB=\"bad\\q\"\nEMPTY=\n# comment")).toEqual({ A: "hello", B: "bad\\q", EMPTY: "" });
  expect(updateEnvText("A=old\nA=duplicate\nB=keep", { A: "new" })).toBe('A="new"\nB=keep\n');
});
