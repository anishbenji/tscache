import type { CacheConfig, GetResult, PutBatch, Range } from "../src/types";

export function engineConfig(
  overrides: Partial<CacheConfig> = {},
): CacheConfig {
  return {
    id: "contract-08",
    interval: 10,
    alignmentOffset: 3,
    fields: { price: "f64", volume: "i16" },
    ...overrides,
  };
}

/** All inputs and expectations use milliseconds and consumer types. */
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
