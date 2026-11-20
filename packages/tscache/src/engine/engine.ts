/**
 * Engine (docs/architecture.md §4.6): a map of CacheState keyed by cache id,
 * with the cache-scoped events. The './engine' export surface (SSR/Node,
 * tests) and what the RPC server drives. No DOM, worker or timer use.
 */

import type { CoverageIndex } from "../coverage";
import { ConfigError, show, UnknownCacheError } from "../errors";
import {
  type CalendarGridContext,
  createCalendarGridContext,
  type Grid,
  gridOf,
  type SlotRange,
  sameCalendar,
} from "../grid";
import type {
  CacheConfig,
  GetResult,
  HydrateResult,
  MemoryStats,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  ResolvedCacheConfig,
  Snapshot,
} from "../types";
import {
  type CacheChange,
  CacheState,
  evictedCoverage,
  type ReaderChange,
} from "./cache";
import { Emitter } from "./emitter";
import { MemoryBudget } from "./memory";
import { resolveCacheConfig } from "./validate";

/** Options of `new Engine` (§2.9). */
export interface EngineOptions {
  /**
   * Upper bound, in bytes, on what the segments of every cache of this
   * engine hold (§2.9): a positive safe integer. Above it the least
   * recently used pages that nothing pins are evicted, with their
   * coverage, so a later read fetches them again. Default: none, and
   * nothing is evicted.
   */
  memoryBudget?: number;
}

/** A budget as `EngineOptions.memoryBudget` and the `memoryBudget` op take it. */
function validBudget(bytes: unknown): number {
  if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 1) {
    throw new ConfigError(
      `memoryBudget must be a positive safe integer of bytes, got ${show(bytes)}`,
    );
  }
  return bytes;
}

export interface EngineEvents {
  /** Cache-scoped (N5). */
  cacheCleared: {
    cacheId: string;
    reason: "manual" | "clear-all" | "version-mismatch";
  };
}

/** Resolved fields that must agree for two configs to name the same cache (N20). */
const STRUCTURAL = [
  "interval",
  "alignmentOffset",
  "fields",
  "gapSplitK",
  "segmentSlotCap",
  "warnOnOverlapDiff",
  "persist",
] as const;

function sameFields(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const names = Object.keys(a);
  return (
    names.length === Object.keys(b).length &&
    names.every((name) => Object.hasOwn(b, name) && a[name] === b[name])
  );
}

/**
 * Whether two resolved intervals name one grid, by value: two numbers when
 * equal, two calendar intervals field by field, and a number never equals a
 * calendar interval (§2.2).
 */
function sameInterval(
  a: ResolvedCacheConfig["interval"],
  b: ResolvedCacheConfig["interval"],
): boolean {
  return typeof a === "number" || typeof b === "number"
    ? a === b
    : sameCalendar(a, b);
}

/** Throws ConfigError naming the first structural field that differs. */
function assertCompatible(
  live: ResolvedCacheConfig,
  wanted: ResolvedCacheConfig,
): void {
  for (const field of STRUCTURAL) {
    const same =
      field === "fields"
        ? sameFields(live.fields, wanted.fields)
        : field === "interval"
          ? sameInterval(live.interval, wanted.interval)
          : live[field] === wanted[field];
    if (!same) {
      throw new ConfigError(
        `cache "${live.id}" exists with a different ${field}; a cache's structure cannot change`,
      );
    }
  }
}

/**
 * Observes what every cache's mutations change: the persister's view of the
 * engine (§4.10.4), and the RPC server's reader report (M7, §4.6). Called
 * synchronously inside the mutating call.
 */
export interface CacheObserver {
  onChange(cacheId: string, change: CacheChange): void;
  onMutate(cacheId: string): void;
  /**
   * Whether this observer has a reader of the cache; asked at the start of
   * each mutating call. Without any observer answering true, no reader
   * change is collected (§3.6).
   */
  hasReaders?(cacheId: string): boolean;
  /**
   * One mutating call's reader change, in slots, once the call ended:
   * after its `cacheCleared` (§3.3).
   */
  onReaderChange?(cacheId: string, change: ReaderChange): void;
  /**
   * A page of the cache was evicted (§4.5), with the coverage that went,
   * in slots; never reported as a change or a mutation. The persister marks
   * the page, so its next flush deletes the record (N95).
   */
  onEvict?(cacheId: string, covered: SlotRange[]): void;
}

/** Internal access for the persister (§4.10.4); set by Engine's static block. */
let stateOf: (engine: Engine, cacheId: string) => CacheState;
let addObserver: (engine: Engine, observer: CacheObserver) => void;
let memoryOf: (engine: Engine) => MemoryBudget | undefined;
let budgetFor: (engine: Engine, bytes: unknown) => number | undefined;
let calendarFor: (engine: Engine, context: CalendarGridContext) => void;

/**
 * A cache's state, for the persister only (§4.10.4): no package entry
 * exports this. Throws UnknownCacheError for an unknown id.
 */
export function cacheStateOf(engine: Engine, cacheId: string): CacheState {
  return stateOf(engine, cacheId);
}

/**
 * A cache's grid, for the orchestrator and the RPC server, which convert
 * slots themselves (§4.1): no package entry exports this. Throws
 * UnknownCacheError for an unknown id.
 */
export function cacheGridOf(engine: Engine, cacheId: string): Grid {
  return stateOf(engine, cacheId).grid;
}

/**
 * Subscribes to the changes and mutations of every cache of the engine,
 * present and future (§4.10.4). For the persister only: no package entry
 * exports this.
 */
export function observeCaches(engine: Engine, observer: CacheObserver): void {
  addObserver(engine, observer);
}

/** What `engineMemoryInternals` reads (tests and diagnostics). */
export interface EngineMemoryInternals {
  /** Pages in the use order; 0 without a budget. */
  readonly orderSize: number;
  /** Pages in the use order that are pinned now; 0 without a budget. */
  readonly pinnedPages: number;
  /** A cache's evicted-coverage index (N104); undefined without a budget. */
  evictedIndex(cacheId: string): CoverageIndex | undefined;
}

/** The engine's memory bookkeeping (M3), for tests: no package entry exports it. */
export function engineMemoryInternals(engine: Engine): EngineMemoryInternals {
  const memory = memoryOf(engine);
  return {
    orderSize: memory?.orderSize ?? 0,
    pinnedPages: memory?.pinnedPages() ?? 0,
    evictedIndex: (cacheId) => evictedCoverage(stateOf(engine, cacheId)),
  };
}

/**
 * Gives an engine the context its calendar grids share (§4.1): the zone
 * rules, the tables of slot starts and the lookup budget. For tests, which
 * inject zone rules and limits through it before the engine's first
 * calendar cache: no package entry exports it.
 */
export function useCalendarGridContext(
  engine: Engine,
  context: CalendarGridContext,
): void {
  calendarFor(engine, context);
}

/**
 * Applies a budget that arrives after construction, by the `memoryBudget`
 * op (N88, N103), and returns the budget in force: the first an engine
 * receives holds for its life, and an engine that already holds a cache
 * takes none. Throws ConfigError for a value that is not a positive safe
 * integer. For the RPC server only: no package entry exports it.
 */
export function applyMemoryBudget(
  engine: Engine,
  bytes: unknown,
): number | undefined {
  return budgetFor(engine, bytes);
}

/**
 * Pins the pages of `slots` in a cache while an orchestrated get is pending
 * (N94); undefined, at the cost of a field read, without a budget. The
 * release is idempotent and ends in enforcement. For the orchestrator only.
 */
export function pinPages(
  engine: Engine,
  cacheId: string,
  slots: SlotRange,
): (() => void) | undefined {
  const memory = memoryOf(engine);
  return memory?.pin(stateOf(engine, cacheId), slots);
}

export class Engine {
  readonly #caches = new Map<string, CacheState>();
  readonly #events = new Emitter<EngineEvents>();
  readonly #observers: CacheObserver[] = [];
  /** The memory budget (M3); undefined without one. */
  #memory: MemoryBudget | undefined;
  /** What the engine's calendar grids share (§4.1); made with the first one. */
  #calendar: CalendarGridContext | undefined;

  static {
    calendarFor = (engine, context) => {
      engine.#calendar = context;
    };
    stateOf = (engine, cacheId) => engine.#state(cacheId);
    addObserver = (engine, observer) => {
      engine.#observers.push(observer);
    };
    memoryOf = (engine) => engine.#memory;
    budgetFor = (engine, bytes) => {
      const budget = validBudget(bytes);
      if (engine.#memory === undefined && engine.#caches.size === 0) {
        engine.#memory = new MemoryBudget(budget);
      }
      return engine.#memory?.budget;
    };
  }

  /** Throws ConfigError for a `memoryBudget` that is not a positive safe integer. */
  constructor(options?: EngineOptions) {
    const budget = options?.memoryBudget;
    if (budget !== undefined)
      this.#memory = new MemoryBudget(validBudget(budget));
  }

  /**
   * Get-or-create (N4, N20). Returns the resolved config the cache was
   * created with; a joining tab's version and finalizedUntil are ignored.
   */
  cache(config: CacheConfig): ResolvedCacheConfig {
    const resolved = resolveCacheConfig(config);
    const live = this.#caches.get(resolved.id);
    if (live !== undefined) {
      assertCompatible(live.config, resolved);
      return live.config;
    }
    const id = resolved.id;
    const observers = this.#observers;
    if (typeof resolved.interval !== "number") {
      this.#calendar ??= createCalendarGridContext();
    }
    const created = new CacheState(resolved, {
      grid: gridOf(resolved, this.#calendar),
      onVersionClear: () => this.#cleared(id, "version-mismatch"),
      onChange: (change) => {
        for (const observer of observers) observer.onChange(id, change);
      },
      onMutate: () => {
        for (const observer of observers) observer.onMutate(id);
      },
      hasReaders: () =>
        observers.some((observer) => observer.hasReaders?.(id) === true),
      onReaderChange: (change) => {
        for (const observer of observers) observer.onReaderChange?.(id, change);
      },
      onEvict: (covered) => {
        for (const observer of observers) observer.onEvict?.(id, covered);
      },
      ...(this.#memory === undefined ? {} : { memory: this.#memory }),
    });
    this.#caches.set(resolved.id, created);
    return created.config;
  }

  /** The resolved config a cache was created with; UnknownCacheError otherwise. */
  configOf(cacheId: string): ResolvedCacheConfig {
    return this.#state(cacheId).config;
  }

  /** Whether a cache with this id exists; never throws. */
  has(cacheId: string): boolean {
    return this.#caches.has(cacheId);
  }

  /**
   * Every present point in the range, with the authoritative sub-ranges and
   * the uncovered ones as 'uncached' misses (§2.3, N16). Current state only:
   * the engine never fetches (the worker's orchestrator does, §4.9).
   * `snapshot: true` adds a Snapshot of the same state (§2.8).
   */
  get(
    cacheId: string,
    range: Range,
    options?: { snapshot?: boolean },
  ): GetResult {
    return this.#state(cacheId).get(range, options);
  }

  /** What the cache knows about the range (§2.8, N34); no read, no orchestration. */
  snapshot(cacheId: string, range: Range): Snapshot {
    return this.#state(cacheId).snapshot(range);
  }

  /**
   * Applies a snapshot where the cache knows nothing (§2.8, N35). One
   * synchronous call, so no other write interleaves; emits no event, since
   * it never clears (its reader change goes to the internal observers).
   */
  hydrate(cacheId: string, snapshot: Snapshot): HydrateResult {
    return this.#state(cacheId).hydrate(snapshot);
  }

  /**
   * Writes a batch (§2.4). A version mismatch clears the cache first and
   * emits `cacheCleared 'version-mismatch'` once the put is applied — or,
   * if the write then fails, before the error propagates.
   */
  put(cacheId: string, batch: PutBatch, options?: PutOptions): PutResult {
    const { warnings } = this.#state(cacheId).put(batch, options);
    return { warnings };
  }

  /** The authoritative sub-ranges of the range (snapped outward), in ms. */
  coverage(cacheId: string, range: Range): Range[] {
    return this.#state(cacheId).coverage(range);
  }

  /** Forgets coverage over the range (snapped outward); the points stay. */
  invalidate(cacheId: string, range: Range): void {
    this.#state(cacheId).invalidate(range);
  }

  /** Drops the cache's data and coverage; emits `cacheCleared 'manual'`. */
  clear(cacheId: string): void {
    this.#state(cacheId).clear(() => this.#cleared(cacheId, "manual"));
  }

  /**
   * Empties every cache (N22); the caches and their configs stay. Every
   * cache is cleared and notified even if a listener throws; the first
   * listener error is rethrown at the end.
   */
  clearAll(): void {
    let failure: { error: unknown } | undefined;
    for (const [cacheId, state] of this.#caches) {
      state.clear(() => {
        try {
          this.#cleared(cacheId, "clear-all");
        } catch (error) {
          failure ??= { error };
        }
      });
    }
    if (failure !== undefined) throw failure.error;
  }

  /**
   * Sets the finalized watermark exactly (§4.5): points at t >= watermark
   * are provisional. Moving it backwards withdraws coverage from there on,
   * so those points are fetched again. Moving it forwards promotes nothing:
   * points that were provisional when stored stay uncovered until the next
   * put over them, since provisional data may have changed meanwhile.
   * Unlike `meta.finalizedUntil` on a put (forwards only, N17), this call
   * may move the watermark in either direction.
   */
  setFinalizedUntil(cacheId: string, t: number): void {
    this.#state(cacheId).setFinalizedUntil(t);
  }

  /**
   * What the caches hold now (§2.9): the bytes of every cache's segments,
   * as the budget counts them, the pinned part, the pages evicted so far,
   * and one entry per cache, ascending by id. Not a use. Without a budget
   * it walks every cache's segments, which only this call pays for.
   */
  memoryStats(): MemoryStats {
    const memory = this.#memory;
    const ids = [...this.#caches.keys()].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    let bytes = 0;
    const caches = ids.map((cacheId) => {
      const state = this.#caches.get(cacheId) as CacheState;
      let pages = 0;
      state.forEachPage(undefined, () => {
        pages++;
      });
      const cacheBytes = state.bytes;
      bytes += cacheBytes;
      return { cacheId, bytes: cacheBytes, pages };
    });
    const stats: MemoryStats = {
      bytes,
      pinnedBytes: memory?.pinnedBytes() ?? 0,
      evictedPages: memory?.evictedPages ?? 0,
      caches,
    };
    if (memory !== undefined) stats.budget = memory.budget;
    return stats;
  }

  on<E extends keyof EngineEvents>(
    event: E,
    fn: (payload: EngineEvents[E]) => void,
  ): () => void {
    return this.#events.on(event, fn);
  }

  off<E extends keyof EngineEvents>(
    event: E,
    fn: (payload: EngineEvents[E]) => void,
  ): void {
    this.#events.off(event, fn);
  }

  #state(cacheId: string): CacheState {
    const state = this.#caches.get(cacheId);
    if (state === undefined) {
      throw new UnknownCacheError(`no cache with id "${cacheId}"`);
    }
    return state;
  }

  #cleared(
    cacheId: string,
    reason: EngineEvents["cacheCleared"]["reason"],
  ): void {
    this.#events.emit("cacheCleared", { cacheId, reason });
  }
}
