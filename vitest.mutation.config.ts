import { defineConfig } from "vitest/config";
import base from "./vitest.config";

// The Vitest configuration Stryker runs (stryker.config.json): the root
// configuration, its aliases and setup file included, narrowed to the
// package's own suite, so a mutant counts as killed only when a test of
// packages/tscache kills it (docs/benchmarks/mutation.md).
const timeout = 60_000;

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
    // killed. Stryker times each mutant run itself (1.5 x the covering
    // tests' time in the initial run + timeoutMS + overhead) and reports a
    // hang as Timeout. These limits sit far above any instrumented test or
    // hook, so for most mutants only Stryker's timeout applies. A test's own
    // timeout overrides testTimeout, so the three tests that set one at two
    // call sites (step 154: the event-order harness's bound-3 tests in
    // packages/tscache/test/persister-event-orders.test.ts and
    // packages/tscache/test/persist-hosted-event-orders.test.ts, set in
    // packages/tscache/test/persist-orders.ts, and the O(log n) test in
    // packages/tscache/test/cache-reader-ranges.test.ts) read
    // tscacheTestTimeout with `inject`, provided as 30 s by the root
    // configuration, which this file replaces with the same 60 s. The
    // exception to Stryker's limit is a mutant whose covering tests take
    // more than about 27.7 s together, such as a static mutant, which runs
    // every test (about 165 s): an async hang there fails here at 60 s and
    // counts as killed (docs/benchmarks/mutation.md). This is the user's
    // exception to the rule against raising timeouts (user decision 90,
    // 2026-11-20), scoped to this file: the root configuration, CI, the
    // hooks and `bun run test` keep Vitest's defaults (5 s per test, 10 s
    // per hook).
    provide: { ...base.test?.provide, tscacheTestTimeout: timeout },
    testTimeout: timeout,
    hookTimeout: timeout,
  },
});
