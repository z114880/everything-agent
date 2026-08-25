import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 收集核心模块和 Web 端的公开行为测试，避免示例脚本被误识别为测试。
    include: ["src/**/*.test.ts", "web/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/engine/src/**/*.ts", "src/loop/**/*.ts", "src/index.ts"],
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
