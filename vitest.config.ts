import { defineConfig } from "vitest/config";

// Vitest runs under Node (never `bun test` — different runner). Engine unit
// tests cover ~90% of logic; browser-mode and Playwright suites arrive at
// steps ⑨–⑫ of the commit plan.
export default defineConfig({
  test: {
    environment: "node",
    include: ["packages/*/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});
