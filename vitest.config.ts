import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试统一放在模块同级的 test 目录，避免实现目录混入测试代码。
    include: ["src/**/test/**/*.test.ts", "web/test/**/*.test.ts", "web/test/**/*.test.tsx"],
    coverage: {
      provider: "v8",
      include: [
        "src/engine/src/**/*.ts",
        "src/agent-loop/agent-loop.ts",
        "src/agent-runtime/**/*.ts",
        "src/memory/**/*.ts",
        "src/tools/manage-memory.ts",
        "src/tools/tool-registry.ts",
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
