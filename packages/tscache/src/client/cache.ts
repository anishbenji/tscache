/**
 * CacheHandle (docs/architecture.md §2.3–§2.4): the per-cache facade over
 * the port. Each method is one RPC op with the cacheId filled in.
 */

import type { PortClient } from "../rpc/port-client";
import { transferablesOf } from "../rpc/protocol";
import type {
  ClientEvents,
  GetOptions,
  GetResult,
  HydrateResult,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  Snapshot,
} from "../types";
import { warnMerges } from "./dev";
import type { ClientEmitter } from "./events";

/** The cache-scoped and request-scoped events, filterable by cacheId. */
export type CacheEvent = "cacheCleared" | "mergeWarning";

export class CacheHandle {
  readonly id: string;
  readonly #port: PortClient;
  readonly #events: ClientEmitter;

  constructor(id: string, port: PortClient, events: ClientEmitter) {
    this.id = id;
    this.#port = port;
    this.#events = events;
  }

  /**
   * Every present point in the range with coverage and misses (§2.3). With
   * `snapshot: true` the result also carries a Snapshot taken from the same
   * state (§2.8); its buffers are transferred to this page with the result.
   */
  get(range: Range, options?: GetOptions): Promise<GetResult> {
    return this.#port.request("get", {
      cacheId: this.id,
      range,
      options,
    }) as Promise<GetResult>;
  }

  /**
   * Writes a batch (§2.4). The batch's typed arrays are TRANSFERRED to the
   * worker and are detached afterwards: pass copies if you still need them.
   * With `warnOnOverlapDiff` on, the result lists where the batch replaced
   * differing values; in development builds this page also prints them in
   * one console.warn (decision #8), and other tabs only get the event.
   */
  async put(batch: PutBatch, options?: PutOptions): Promise<PutResult> {
    const result = (await this.#port.request(
      "put",
      { cacheId: this.id, batch, options },
      transferablesOf(batch),
    )) as PutResult;
    warnMerges(this.id, result.warnings);
    return result;
  }

  /**
   * Applies a snapshot where this cache knows nothing (§2.8, N35): taken by
   * `get(range, { snapshot: true })`, typically on a server, and carried in
   * the page with `encodeSnapshot`. A snapshot of another dataset version is
   * refused (`skipped: 'version-mismatch'`); covered and provisional slots
   * are never touched. The snapshot is cloned, not transferred, so it stays
   * usable. A worker from before this op rejects with TscacheError: treat
   * that as not seeded and let the cache fetch (N37).
   */
  hydrate(snapshot: Snapshot): Promise<HydrateResult> {
    return this.#port.request("hydrate", {
      cacheId: this.id,
      snapshot,
    }) as Promise<HydrateResult>;
  }

  /** Forgets coverage over the range (snapped outward); the points stay. */
  async invalidate(range: Range): Promise<void> {
    await this.#port.request("invalidate", { cacheId: this.id, range });
  }

  /** Drops this cache's data. In SharedWorker mode this affects ALL tabs. */
  async clear(): Promise<void> {
    await this.#port.request("clear", { cacheId: this.id });
  }

  setFinalizedUntil(t: number): Promise<void> {
    return this.#port.request("setFinalizedUntil", {
      cacheId: this.id,
      t,
    }) as Promise<void>;
  }

  /** `client.on` filtered to this cache; returns the unsubscribe. */
  on<E extends CacheEvent>(
    event: E,
    fn: (payload: ClientEvents[E]) => void,
  ): () => void {
    return this.#events.on(event, (payload) => {
      if (payload.cacheId === this.id) fn(payload);
    });
  }
}
