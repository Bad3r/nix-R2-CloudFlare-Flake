import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.ts"],
    // tests/workers/** runs inside workerd via vitest.workers.config.ts.
    exclude: ["tests/workers/**"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
