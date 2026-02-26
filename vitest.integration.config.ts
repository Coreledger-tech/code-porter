import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/api/test/**/*.spec.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 180000,
    coverage: {
      enabled: false
    }
  }
});
