import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "cobertura"],
      // Today's coverage, floored: a change that drops below it fails.
      thresholds: { statements: 93, branches: 86, functions: 94, lines: 96 },
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts", "test/scripts/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        test: {
          name: "contract",
          include: ["test/contract/**/*.test.ts"],
          environment: "node",
          fileParallelism: false,
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          globalSetup: ["test/browser/setup.ts"],
          browser: {
            enabled: true,
            provider: playwright(),
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
});
