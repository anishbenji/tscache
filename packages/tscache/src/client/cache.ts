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
  PutBatch,
  PutOptions,
  PutResult,
  Range,
} from "../types";
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
   * Every present point in the range with coverage and misses (§2.3). Until
   * orchestration (step ⑪) every get is cache-only.
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
   */
  put(batch: PutBatch, options?: PutOptions): Promise<PutResult> {
    return this.#port.request(
      "put",
      { cacheId: this.id, batch, options },
      transferablesOf(batch),
    ) as Promise<PutResult>;
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
