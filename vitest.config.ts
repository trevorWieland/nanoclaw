import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "setup/**/*.test.ts", "container/**/*.test.ts"],
    coverage: {
      provider: "v8",
      exclude: [
        // Barrel/re-export files with no testable logic.
        "src/channels/index.ts",
        "src/datastore/index.ts",
        "src/tanren/index.ts",
        // Being replaced by official Tanren MCP server + CLI.
        "container/agent-runner/src/tanren-mcp-stdio.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 75,
        functions: 74,
        lines: 80,
      },
    },
  },
});
