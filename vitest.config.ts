import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Fixtures are scanner INPUT. Some deliberately contain *.test.ts files
    // (to prove the scanner skips them); vitest must never execute those.
    exclude: ["**/node_modules/**", "test/fixtures/**"],
    testTimeout: 60_000,
  },
});
