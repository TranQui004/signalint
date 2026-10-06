import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "lcov"],
      // Thresholds are set 5% below the measured baseline (2026-09-04, 93 tests).
      // They enforce that coverage does not regress; not that every new feature
      // gets unit-tested before integration tests.
      // Measured baseline: statements 84.2, branches 74.97, functions 88.37, lines 84.31
      thresholds: {
        statements: 79,
        branches: 70,
        functions: 83,
        lines: 79,
      },
    },
  },
});
