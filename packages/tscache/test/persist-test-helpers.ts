import { expect } from "vitest";
import { CacheState, type CacheStateHooks } from "../src/engine/cache";
import { Engine } from "../src/engine/engine";
import { resolveCacheConfig } from "../src/engine/validate";
import type { CacheRecord, PageRecord } from "../src/persist/records";
import type { StoredCache } from "../src/persist/store";
import type { CacheConfig, PutBatch, Range } from "../src/types";

// These are exactly the additive §4.10.4–5 contracts. Keeping the extension
// here lets tsc distinguish absent production modules from test mistakes.
export type Change =
  | { kind: "write" | "remove"; slots: Range }
  | { kind: "clear" | "version" | "watermark" };
export type PersistConfig = CacheConfig & { persist?: boolean };
export type RestoreCache = CacheState & {
  restore: (records: { cache: unknown; pages: readonly unknown[] }) => {
    applied: Range[];
    rewrite: boolean;
  };
};
export type Hooks = CacheStateHooks & {
  onChange?: (change: Change) => void;
  onMutate?: () => void;
};
export const all: Range = { start: -1000, end: 1000 };
export const allPages: Range[] = [{ start: -Infinity, end: Infinity }];
export function config(overrides: Partial<PersistConfig> = {}): PersistConfig {
  return {
    id: "persist",
    interval: 1,
    fields: { value: "f64" },
    segmentSlotCap: 4,
    persist: true,
    ...overrides,
  };
}
export function state(
  overrides: Partial<PersistConfig> = {},
  hooks: Hooks = {},
): RestoreCache {
  return new CacheState(
    resolveCacheConfig(config(overrides)),
    hooks,
  ) as RestoreCache;
}
export function batch(
  timestamps: number[],
  values: number[] = timestamps,
): PutBatch {
  return { timestamps, fields: { value: values } };
}

/** Independent oracle specified by §4.10.2, using coverage and snapshots only.
 * Deliberately never calls persist/records.ts's production record builders. */
export function recordsOf(
  engine: Pick<Engine, "configOf" | "coverage" | "snapshot">,
  id = "persist",
): StoredCache {
  const c = engine.configOf(id);
  const coverage = engine.coverage(id, all);
  if (coverage.length === 0) return { cache: undefined, pages: [] };
  const cap = c.segmentSlotCap;
  const pageCoverage = new Map<number, Range[]>();
  for (const r of coverage) {
    const start = (r.start - c.alignmentOffset) / c.interval;
    const end = (r.end - c.alignmentOffset) / c.interval;
    for (let p = Math.floor(start / cap); p <= Math.floor(end / cap); p++) {
      const ranges = pageCoverage.get(p) ?? [];
      ranges.push({
        start: Math.max(start, p * cap) * c.interval + c.alignmentOffset,
        end: Math.min(end, p * cap + cap - 1) * c.interval + c.alignmentOffset,
      });
      pageCoverage.set(p, ranges);
    }
  }
  const envelope = engine.snapshot(id, all);
  const cache: CacheRecord = {
    cacheId: id,
    format: 1,
    config: {
      interval: c.interval,
      alignmentOffset: c.alignmentOffset,
      fields: { ...c.fields },
      gapSplitK: c.gapSplitK,
      segmentSlotCap: cap,
      warnOnOverlapDiff: c.warnOnOverlapDiff,
    },
  };
  if (envelope.version !== undefined) cache.version = envelope.version;
  if (envelope.finalizedUntil !== undefined)
    cache.finalizedUntil = envelope.finalizedUntil;
  const pages: PageRecord[] = [...pageCoverage]
    .sort(([a], [b]) => a - b)
    .map(([page, ranges]) => {
      const first = ranges[0];
      const last = ranges.at(-1);
      if (first === undefined || last === undefined)
        throw new Error("empty oracle page");
      const { finalizedUntil: _ignored, ...snapshot } = engine.snapshot(id, {
        start: first.start,
        end: last.end,
      });
      snapshot.segments = ranges.flatMap(
        (range) => engine.snapshot(id, range).segments,
      );
      return { cacheId: id, page, snapshot };
    });
  return { cache, pages };
}

export function fixture(
  overrides: Partial<PersistConfig> = {},
  times: number[] = [-1, 0, 1, 3, 4, 7],
): StoredCache {
  const e = new Engine();
  const c = config(overrides);
  e.cache(c);
  e.put(c.id, batch(times));
  return recordsOf(e, c.id);
}
export function requireCache(records: StoredCache): CacheRecord {
  if (records.cache === undefined)
    throw new Error("fixture needs cache record");
  return records.cache;
}
export function requirePage(records: StoredCache, index = 0): PageRecord {
  const p = records.pages[index];
  if (p === undefined) throw new Error("fixture needs page");
  return p;
}
export function expectRecords(
  actual: StoredCache,
  engine: Engine,
  id = "persist",
): void {
  expect(actual).toEqual(recordsOf(engine, id));
}
export function rng(seed: number): (max: number) => number {
  let n = seed >>> 0;
  return (max) => {
    n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
    return n % max;
  };
}
export function tracked(promise: Promise<void>): {
  done: boolean;
  promise: Promise<void>;
} {
  const result = { done: false, promise: Promise.resolve() };
  result.promise = promise.then(() => {
    result.done = true;
  });
  return result;
}

export function stateRecords(cache: CacheState): StoredCache {
  return recordsOf(
    {
      configOf: () => cache.config,
      coverage: (_id, range) => cache.coverage(range),
      snapshot: (_id, range) => cache.snapshot(range),
    },
    cache.config.id,
  );
}
