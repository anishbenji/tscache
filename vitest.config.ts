/// <reference path="packages/tscache/test/provided-context.d.ts" />
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const entry = (name: string) =>
  fileURLToPath(
    new URL(`packages/tscache/src/entries/${name}.ts`, import.meta.url),
  );

// Vitest runs under Node (never `bun test` — different runner). Behaviour
// that needs a browser is tested by the Playwright suites
// (playwright.config.ts), not by Vitest's browser mode.
export default defineConfig({
  // The examples' unit tests import the package by name, whose exports
  // point into dist/; `bun run test` can run before any build, or against a
  // dist/ older than the source, so they resolve to the source instead, as
  // the package's own tests do.
  resolve: {
    alias: [
      { find: /^@anishbenji\/tscache$/, replacement: entry("index") },
      {
        find: /^@anishbenji\/tscache\/fetcher$/,
        replacement: entry("fetcher"),
      },
      { find: /^@anishbenji\/tscache\/grid$/, replacement: entry("grid") },
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
      "e2e/docs/*.test.ts",
      "scripts/**/*.test.ts",
      "site/scripts/**/*.test.ts",
    ],
    passWithNoTests: true,
    // CacheState.restore's implementation, which the persister installs in
    // production (packages/tscache/test/setup-restore.ts); and no real
    // BroadcastChannel, which in Node would join every test file of the
    // process to one workers' channel (packages/tscache/test/setup-channel.ts).
    setupFiles: [
      "packages/tscache/test/setup-restore.ts",
      "packages/tscache/test/setup-channel.ts",
    ],
    // Vitest's default 5 s test timeout, which only catches a hang. Chore 19
    // raised it to 20 s after two runs at load 20-28 crossed 5 s; with
    // every core busy the slowest test now takes 1.6 s (chore 28), and
    // heavy jobs on the shared machine run one at a time. A test that
    // crosses 5 s again is a slowdown to investigate, not to raise. The one
    // exception is a deterministic, CPU-bound test whose cost is the work it
    // checks (an exhaustive enumeration, or a scan the test measures): its
    // time is measured under load and its own timeout, about twice the worst
    // case, is named and explained at the call site. The exception covers
    // three tests only (user decision 2026-11-26, step 154, beside user
    // decision 90; docs/testing.md, Waiting): the event-order harness's
    // bound-3 tests in packages/tscache/test/persister-event-orders.test.ts
    // and packages/tscache/test/persist-hosted-event-orders.test.ts (one
    // setting in packages/tscache/test/persist-orders.ts; Vitest runs each
    // file's test once per first event, six cases), and the O(log n) test
    // in packages/tscache/test/cache-reader-ranges.test.ts, 30 s each,
    // passed at two call sites. Any other test needs the user's OK again,
    // with measurements; the exception does not extend by itself.
    //
    // The 30 s is provided here as tscacheTestTimeout, and the two call
    // sites read it with `inject`; vitest.mutation.config.ts provides its own
    // 60 s the same way. A provided value comes only from a configuration,
    // never from the shell. A run that loads neither configuration provides
    // nothing, so the three tests get Vitest's default timeout.
    provide: { tscacheTestTimeout: 30_000 },
  },
});
