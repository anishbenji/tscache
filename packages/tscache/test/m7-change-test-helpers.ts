// fallow-ignore-file duplicate-export
// The test helpers each export a `batch` and a `config` of their own; Fallow
// audits the pairs among the files a branch changes (step 129).
import { vi } from "vitest";
import type { CacheChange } from "../src/engine/cache";
import {
  type CacheObserver,
  cacheGridOf,
  Engine,
  observeCaches,
} from "../src/engine/engine";
import { type SlotRange, toMs } from "../src/grid";
import type { CacheConfig, PutBatch, Range } from "../src/types";

/**
 * Test adapter for the deliberately loose seam in M7 §3.9. Extend the
 * existing internal observeCaches/CacheObserver export with these two
 * members; no package entry or public Engine event needs a new export.
 * Reports use slots here; the server converts them to ms (§3.9).
 * The intersection keeps absent reader behaviour distinct from test
 * type errors while the implementer supplies this internal extension.
 */
interface ReaderReport {
  written: SlotRange[];
  removed: SlotRange[];
  cleared: boolean;
}

interface ReaderObserver {
  hasReaders(cacheId: string): boolean;
  onReaderChange(cacheId: string, report: ReaderReport): void;
}

export interface ChangeEvent {
  cacheId: string;
  written: Range[];
  removed: Range[];
  cleared: boolean;
}

export type OrderedEvent =
  | { kind: "changed"; event: ChangeEvent }
  | {
      kind: "cleared";
      cacheId: string;
      reason: "manual" | "clear-all" | "version-mismatch";
    };

export const id = "m7";
export const view: Range = { start: -37, end: 83 };

export function config(overrides: Partial<CacheConfig> = {}): CacheConfig {
  return {
    id,
    interval: 10,
    alignmentOffset: 3,
    fields: { value: "f64" },
    segmentSlotCap: 4,
    gapSplitK: 1,
    ...overrides,
  };
}

export function batch(
  timestamps: number[],
  values: number[] = timestamps,
  meta?: PutBatch["meta"],
): PutBatch {
  return {
    timestamps,
    fields: { value: values },
    ...(meta === undefined ? {} : { meta }),
  };
}

export function change(
  written: Range[] = [],
  removed: Range[] = [],
  cleared = false,
  cacheId: string = id,
): ChangeEvent {
  return { cacheId, written, removed, cleared };
}

export function observed(overrides: Partial<CacheConfig> = {}): {
  engine: Engine;
  events: ChangeEvent[];
  order: OrderedEvent[];
  disk: { cacheId: string; change: CacheChange }[];
  subscribers: Set<string>;
  report: ReturnType<typeof vi.fn<ReaderObserver["onReaderChange"]>>;
  reset(): void;
} {
  const engine = new Engine();
  const events: ChangeEvent[] = [];
  const order: OrderedEvent[] = [];
  const disk: { cacheId: string; change: CacheChange }[] = [];
  const subscribers = new Set([overrides.id ?? id]);
  const report = vi.fn<ReaderObserver["onReaderChange"]>((cacheId, report) => {
    const grid = cacheGridOf(engine, cacheId);
    const event: ChangeEvent = {
      cacheId,
      written: report.written.map((range) => toMs(range, grid)),
      removed: report.removed.map((range) => toMs(range, grid)),
      cleared: report.cleared,
    };
    events.push(event);
    order.push({ kind: "changed", event });
  });
  const observer: CacheObserver & ReaderObserver = {
    onChange: (cacheId, change) => disk.push({ cacheId, change }),
    onMutate: () => {},
    hasReaders: (cacheId) => subscribers.has(cacheId),
    onReaderChange: report,
  };
  observeCaches(engine, observer);
  engine.on("cacheCleared", ({ cacheId, reason }) => {
    order.push({ kind: "cleared", cacheId, reason });
  });
  engine.cache(config(overrides));
  return {
    engine,
    events,
    order,
    disk,
    subscribers,
    report,
    reset: () => {
      events.length = 0;
      order.length = 0;
      disk.length = 0;
      report.mockClear();
    },
  };
}
