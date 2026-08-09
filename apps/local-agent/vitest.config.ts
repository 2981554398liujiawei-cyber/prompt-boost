import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 每个测试文件独立 worker + 隔离模块图：环境变量副作用互不泄漏。
    isolate: true,
  },
});
