import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// The Vitest configuration Stryker runs (stryker.config.json): the root
// configuration, its aliases and setup file included, narrowed to the
// package's own suite, so a mutant counts as killed only when a test of
// packages/tscache kills it (docs/benchmarks/mutation.md).
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["packages/tscache/test/**/*.test.ts"],
    // Under Stryker's per-test coverage instrumentation a test runs many
    // times slower than under plain Vitest: the 8 MB memory-budget test in
    // test/perf/memory-budget.test.ts takes about 300 ms plainly and 4.5 s
    // or more instrumented (step 124), close to Vitest's 5 s default. A
    // Vitest timeout fails the test, so Stryker would count the mutant as
    // killed. Stryker times each mutant run itself (timeoutMS and
    // timeoutFactor, from the measured initial run) and reports a hang as
    // Timeout, so these limits sit far above any instrumented test or hook
    // and only Stryker's own timeout applies (docs/benchmarks/mutation.md).
    // This is the user's exception to the rule against raising timeouts
    // (user decision 90, 2026-11-20), scoped to this file: the root
    // configuration, CI, the hooks and `bun run test` keep the defaults.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
