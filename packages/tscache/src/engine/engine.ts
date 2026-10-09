/**
 * Engine (docs/architecture.md §4.6): a map of CacheState keyed by cache id,
 * with the cache-scoped events. The './engine' export surface (SSR/Node,
 * tests) and what the RPC server drives. No DOM, worker or timer use.
 */

import { ConfigError, UnknownCacheError } from "../errors";
import type {
  CacheConfig,
  GetResult,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  ResolvedCacheConfig,
} from "../types";
import { CacheState } from "./cache";
import { Emitter } from "./emitter";
import { resolveCacheConfig } from "./validate";

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

/** Throws ConfigError naming the first structural field that differs. */
function assertCompatible(
  live: ResolvedCacheConfig,
  wanted: ResolvedCacheConfig,
): void {
  for (const field of STRUCTURAL) {
    const same =
      field === "fields"
        ? sameFields(live.fields, wanted.fields)
        : live[field] === wanted[field];
    if (!same) {
      throw new ConfigError(
        `cache "${live.id}" exists with a different ${field}; a cache's structure cannot change`,
      );
    }
  }
}

export class Engine {
  readonly #caches = new Map<string, CacheState>();
  readonly #events = new Emitter<EngineEvents>();

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
    const created = new CacheState(resolved, {
      onVersionClear: () => this.#cleared(resolved.id, "version-mismatch"),
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
   * orchestration arrives at step ⑪.
   */
  get(cacheId: string, range: Range): GetResult {
    return this.#state(cacheId).get(range);
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
    this.#state(cacheId).clear();
    this.#cleared(cacheId, "manual");
  }

  /**
   * Empties every cache (N22); the caches and their configs stay. Every
   * cache is cleared and notified even if a listener throws; the first
   * listener error is rethrown at the end.
   */
  clearAll(): void {
    let failure: { error: unknown } | undefined;
    for (const [cacheId, state] of this.#caches) {
      state.clear();
      try {
        this.#cleared(cacheId, "clear-all");
      } catch (error) {
        failure ??= { error };
      }
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
