// The values the Vitest configurations provide to the tests (`test.provide`
// in vitest.config.ts and vitest.mutation.config.ts), read with `inject`.
// A provided value comes only from a configuration, never from the shell.
export {};

declare module "vitest" {
  interface ProvidedContext {
    /**
     * The timeout of the three tests with their own (step 154): 30 s in
     * vitest.config.ts, 60 s in vitest.mutation.config.ts. Absent when
     * Vitest runs with neither configuration, so the tests get Vitest's
     * default.
     */
    tscacheTestTimeout?: number;
  }
}
