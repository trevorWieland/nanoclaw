import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "src/**/*.test.ts",
      "setup/**/*.test.ts",
      "container/**/*.test.ts",
      "!src/**/*.integration.test.ts",
      "!container/**/*.integration.test.ts",
    ],
    coverage: {
      provider: "v8",
      exclude: [
        // Barrel/re-export files with no testable logic.
        "src/channels/index.ts",
        "src/datastore/index.ts",
        "src/tanren/index.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 74,
        functions: 74,
        lines: 80,
      },
    },
  },
});
