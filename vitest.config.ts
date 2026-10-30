import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const entry = (name: string) =>
  fileURLToPath(
    new URL(`packages/tscache/src/entries/${name}.ts`, import.meta.url),
  );

// Vitest runs under Node (never `bun test` — different runner). Engine unit
// tests cover ~90% of logic; browser-mode and Playwright suites arrive at
// steps ⑨–⑫ of the commit plan.
export default defineConfig({
  // The examples' unit tests import the package by name, whose exports
  // point into dist/; `bun run ci` runs Vitest before the build, so they
  // resolve to the source instead, as the package's own tests do.
  resolve: {
    alias: [
      { find: /^tscache$/, replacement: entry("index") },
      { find: /^tscache\/fetcher$/, replacement: entry("fetcher") },
    ],
  },
  test: {
    environment: "node",
    include: [
      "packages/*/test/**/*.test.ts",
      "examples/*/test/**/*.test.ts",
      "integrations/test/**/*.test.ts",
      "reference/*/test/**/*.test.ts",
      "e2e/examples/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    passWithNoTests: true,
    // On a loaded machine the heavy property tests ran 20-40x slower than
    // idle (7.8 s against 373 ms) and crossed the 5 s default (chore/19).
    testTimeout: 20_000,
  },
});
