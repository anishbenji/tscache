import { expect } from "vitest";
import { CacheState } from "../src/engine/cache";
import { resolveCacheConfig } from "../src/engine/validate";
import { PutError, type PutErrorCode } from "../src/errors";
import type {
  CacheConfig,
  GetResult,
  PutBatch,
  Range,
  ResolvedCacheConfig,
} from "../src/types";

export function cache(overrides: Partial<CacheConfig> = {}): CacheState {
  return new CacheState(
    resolveCacheConfig({
      id: "contract-07",
      interval: 10,
      alignmentOffset: 3,
      fields: { price: "f64", volume: "i16" },
      ...overrides,
    }),
  );
}

/** Inputs and expectations here are milliseconds, never internal slots. */
export function batch(
  timestamps: number[],
  prices: number[] = timestamps,
  volumes: number[] = timestamps,
): PutBatch {
  return { timestamps, fields: { price: prices, volume: volumes } };
}

export function result(
  timestamps: number[],
  coverage: Range[],
  misses: Range[],
  prices: number[] = timestamps,
  volumes: number[] = timestamps,
): GetResult {
  return {
    timestamps: new Float64Array(timestamps),
    fields: {
      price: new Float64Array(prices),
      volume: new Int16Array(volumes),
    },
    coverage,
    misses: misses.map((range) => ({ range, reason: "uncached" })),
  };
}

export function observe(c: CacheState): {
  data: GetResult;
  config: ResolvedCacheConfig;
  version: string | undefined;
  finalizedUntil: number | undefined;
} {
  return {
    data: c.get({ start: -197, end: 203 }),
    config: structuredClone(c.config),
    version: c.version,
    finalizedUntil: c.finalizedUntil,
  };
}

export function expectPutError(
  action: () => unknown,
  code: PutErrorCode,
  offenderIndex: number,
): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(PutError);
  expect(error).toMatchObject({ code, offenderIndex });
}

export const malformedRanges: unknown[] = [
  null,
  1,
  "range",
  {},
  { start: 0 },
  { end: 0 },
  { start: 23, end: 3 },
  ...[
    Number.NaN,
    Infinity,
    -Infinity,
    2 ** 53,
    -(2 ** 53),
    "3",
    null,
    true,
  ].flatMap((value) => [
    { start: value, end: 23 },
    { start: -17, end: value },
  ]),
];
