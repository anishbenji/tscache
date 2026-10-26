import { describe, expect, it } from "vitest";
import {
  candleConfig,
  FIELDS,
  pages,
  type Shape,
  series,
} from "../../bench/fixtures";
import { Engine } from "../../src/engine/engine";
import { FIELD_ARRAYS } from "../../src/segment/dtype";

// Performance budget (docs/benchmarking.md): the memory a cached point
// keeps, measured as the growth of ArrayBuffer memory after a full
// collection, with the engine held alive across the reading. Exact under
// Node: the typed arrays are the cache's storage, and nothing else in the
// test allocates them.

/**
 * Node's modules, through specifiers TypeScript does not resolve: the
 * package has no Node type definitions (vite-fetcher-url.test.ts). Vitest
 * runs under Node.
 */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;
const { setFlagsFromString } = await load<{
  setFlagsFromString(flags: string): void;
}>("node:v8");
const { runInNewContext } = await load<{
  runInNewContext(code: string): unknown;
}>("node:vm");
const { memoryUsage } = await load<{
  memoryUsage(): { arrayBuffers: number };
}>("node:process");

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

/** Holds what was measured until the test ends, so it is not collected. */
const held: unknown[] = [];

function arrayBufferBytes(): number {
  gc();
  gc();
  return memoryUsage().arrayBuffers;
}

/** ArrayBuffer bytes a year of `shape`, put day by day, keeps per bar. */
function bytesPerBar(shape: Shape): number {
  const data = series(shape, 365);
  const days = pages(data, 1);
  const before = arrayBufferBytes();
  const engine = new Engine();
  const { id } = engine.cache(candleConfig(shape));
  for (const { batch, range } of days) engine.put(id, batch, { range });
  held.push(engine);
  const after = arrayBufferBytes();
  return (after - before) / data.timestamps.length;
}

/** What a bar's fields take, with nothing else: the floor. */
const FIELD_BYTES = Object.values(FIELDS).reduce(
  (sum, dtype) => sum + FIELD_ARRAYS[dtype].BYTES_PER_ELEMENT,
  0,
);

describe("memory per cached bar", () => {
  // Measured 2026-10-26, the same on every run: allDay 36.233 B, sessions
  // 36.000 B, dropout 36.745 B, against 36 B of fields (a full segment
  // keeps no presence mask). The budgets leave about 1.5 %.
  for (const [shape, budget] of [
    ["allDay", 36.75],
    ["sessions", 36.75],
    ["dropout", 37.25],
  ] as const) {
    it(`stays within ${budget} B for a year of ${shape} bars`, () => {
      const bytes = bytesPerBar(shape);
      // Below the fields' bytes means the engine was collected: the
      // reading is wrong, not the cache small.
      expect(bytes).toBeGreaterThanOrEqual(FIELD_BYTES);
      expect(bytes).toBeLessThanOrEqual(budget);
    });
  }
});
