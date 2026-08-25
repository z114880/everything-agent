import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只收集 Engine 的公开行为测试，避免示例脚本被误识别为测试。
    include: ["engine/test/**/*.test.js"],
    coverage: {
      provider: "v8",
      include: ["engine/src/**/*.js"],
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
