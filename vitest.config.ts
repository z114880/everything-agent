import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试统一放在模块同级的 test 目录，避免实现目录混入测试代码。
    include: ["deploy/**/test/**/*.test.ts", "src/**/test/**/*.test.ts", "mock-data/test/**/*.test.ts", "web/test/**/*.test.ts", "web/test/**/*.test.tsx"],
    // 清掉宿主可能带入的 Langfuse 凭证，避免测试打到真实地址；用例需要时自行 stub。
    setupFiles: ["src/test/setup-test-env.ts"],
    coverage: {
      provider: "v8",
      include: [
        "src/engine/src/**/*.ts",
        "src/evaluation/**/*.ts",
        "deploy/langfuse/configuration.ts",
        "src/agent-loop/agent-loop.ts",
        "src/agent-runtime/**/*.ts",
        "src/memory/**/*.ts",
        "src/skills/**/*.ts",
        "src/sandbox/**/*.ts",
        "src/tools/manage-memory.ts",
        "src/tools/tool-registry.ts",
        "src/tools/approval.ts",
        "src/tools/tavily-search.ts",
        "src/tools/terminal.ts",
        "src/tools/tool-settings.ts",
        "src/tracing/**/*.ts",
        "src/index.ts",
      ],
      reporter: ["text", "html"],
      // 基础引擎代码量较小，较高门槛可防止新增分支却没有相应用例。
      thresholds: {
        lines: 90,
        functions: 90,
        statements: 90,
        branches: 85,
      },
    },
  },
});
