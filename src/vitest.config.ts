import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // tsc emits compiled tests into dist/; only the TypeScript sources are the test suite.
    exclude: [...configDefaults.exclude, "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html", "lcov"],
      include: ["app/**/*.ts"],
      exclude: ["app/server.ts", "tests/**", "dist/**", "**/*.d.ts"],
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 90,
      },
    },
  },
});