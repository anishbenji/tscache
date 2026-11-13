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
  },
});
