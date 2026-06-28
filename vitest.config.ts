import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit/integration tests live under test/.
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Deterministic, no globals — import explicitly from "vitest".
    globals: false,
    clearMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // The CLI bootstrap (index.ts) is exercised via a child process, not unit
      // tests, so exclude it from coverage thresholds.
      exclude: ["src/index.ts"],
      reporter: ["text", "html"],
    },
  },
});
