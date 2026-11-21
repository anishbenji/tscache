// fallow-ignore-file duplicate-export
// The test helpers each export a `batch` of their own (step 129).
import { expect, vi } from "vitest";
import {
  Engine,
  type EngineOptions,
  useCalendarGridContext,
} from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import * as grid from "../src/grid";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { Persister } from "../src/persist/persister";
import type { StoredCache } from "../src/persist/store";
import type {
  CacheConfig,
  CalendarSnapshot,
  FetchRequest,
  HydrateResult,
  PutBatch,
  Range,
  ResolvedCacheConfig,
  Snapshot,
} from "../src/types";
import { finish } from "./persist-harness";
import { MemoryStore } from "./persist-memory-store";

export const HOUR = 3_600_000;
export const DAY: number = 24 * HOUR;
export const ID = "calendar-contract";
export const NY = "America/New_York";
export const APIA = "Pacific/Apia";
export const utc = (iso: string): number => Date.parse(iso);
export const span = (start: number, end: number = start): Range => ({
  start,
  end,
});
export const daySlot = (date: string): number => utc(date) / DAY;
export const slots = (first: number, last: number): number[] =>
  Array.from({ length: last - first + 1 }, (_, i) => first + i);

export interface CalendarDescriptor {
  unit: "day" | "week" | "month" | "quarter" | "year";
  zone?: string;
  at?: string;
  weekStart?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
}

type OffsetAt = (instant: number) => number;

interface CalendarGridContext {
  readonly tableCount: number;
}

interface GridOptions {
  offsetAt?: (zone: string, instant: number) => number;
  onFloorStep?: (direction: -1 | 1) => void;
  tableCapacity?: number;
  lookupBudget?: number;
}

// These entry points are the proposed test seam for §9. They are looked up
// inside tests so absent exports do not prevent the fixed controls from running.
const makeContext = (options: GridOptions = {}): CalendarGridContext =>
  grid.createCalendarGridContext(options);
export const calendarGrid = (
  descriptor: CalendarDescriptor,
  context?: ReturnType<typeof makeContext>,
): grid.Grid => grid.createCalendarGrid(descriptor, context);
export const startOf = (slot: number, g: grid.Grid): number =>
  grid.startOf(slot, g);
export const floorSlot = (instant: number, g: grid.Grid): number =>
  grid.floorSlot(instant, g);
export const resolveCalendarStart = (nominal: number, g: grid.Grid): number =>
  grid.resolveCalendarStart(nominal, g);

export function probe(
  offset: OffsetAt,
  options: Omit<GridOptions, "offsetAt"> = {},
): { context: CalendarGridContext; lookups: number[] } {
  const lookups: number[] = [];
  const context = makeContext({
    ...options,
    offsetAt: (_zone, instant) => {
      lookups.push(instant);
      return offset(instant);
    },
  });
  return { context, lookups };
}

export const nyOffset = (
  instant: number,
  spring: number = utc("2026-03-08T07:00Z"),
): number =>
  instant >= spring && instant < utc("2026-11-01T06:00Z")
    ? -4 * HOUR
    : -5 * HOUR;
export const apiaOffset =
  (jump: number): OffsetAt =>
  (instant) =>
    instant < jump ? -10 * HOUR : 14 * HOUR;

export function engine(
  interval: CalendarDescriptor | number,
  options: Partial<CacheConfig> = {},
  context?: ReturnType<typeof makeContext>,
  engineOptions?: EngineOptions,
): Engine {
  const e = new Engine(engineOptions);
  // B1: the context reaches the engine through an internal seam, not a
  // public option.
  if (context !== undefined) useCalendarGridContext(e, context);
  addCache(e, interval, options);
  return e;
}

export function addCache(
  e: Engine,
  interval: CalendarDescriptor | number,
  options: Partial<CacheConfig> = {},
): ResolvedCacheConfig {
  return e.cache({
    id: ID,
    interval,
    fields: { value: "f64" },
    ...options,
  } as unknown as CacheConfig);
}

export const batch = (
  timestamps: number[],
  value: number[] = timestamps,
): PutBatch => ({
  timestamps,
  fields: { value },
});

export const miss = (range: Range): { range: Range; reason: "uncached" } => ({
  range,
  reason: "uncached",
});

export function format2(snapshot: Snapshot): CalendarSnapshot {
  expect(snapshot.format).toBe(2);
  return snapshot as CalendarSnapshot;
}

/** Widen only at the boundary where the runtime must validate untrusted input. */
export const hydrate = (e: Engine, snapshot: unknown): HydrateResult =>
  e.hydrate(ID, snapshot as Snapshot);

export function expectTscacheError(
  action: () => unknown,
  field?: RegExp,
): void {
  let error: unknown;
  try {
    action();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(TscacheError);
  expect(error?.constructor).toBe(TscacheError);
  if (field !== undefined)
    expect(error).toHaveProperty("message", expect.stringMatching(field));
}

export async function persisted(
  e: Engine,
  records?: StoredCache,
): Promise<{
  store: MemoryStore;
  flush: () => Promise<void>;
  records: () => StoredCache;
}> {
  const store = new MemoryStore();
  if (records !== undefined) store.seed(ID, records);
  const persister = new Persister(e, async () => store);
  await persister.open(ID);
  return {
    store,
    flush: () => finish(persister.flush(ID)),
    records: () => store.records(ID),
  };
}

export async function withFetcher(
  e: Engine,
  fetch: (request: FetchRequest) => PutBatch,
): Promise<{ orchestrator: Orchestrator; requests: FetchRequest[] }> {
  const orchestrator = new Orchestrator(e, () => {});
  const requests: FetchRequest[] = [];
  const bridge = {
    fetch(request: FetchRequest) {
      requests.push(request);
      return fetch(request);
    },
  };
  // Give the dynamically imported test fetcher the fixture, as the existing
  // orchestrator tests do. Each orchestrator imports the same stateless bridge.
  vi.stubGlobal("calendarContractFetcher", bridge);
  const source =
    "export default { fetch: (request) => globalThis.calendarContractFetcher.fetch(request) }";
  await orchestrator.load({
    module: `data:text/javascript,${encodeURIComponent(source)}`,
  });
  return { orchestrator, requests };
}
