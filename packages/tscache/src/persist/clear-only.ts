/**
 * The persistence of the dedicated-worker and in-process hostings
 * (docs/architecture.md §4.10.7, §4.10.8, N66): they persist nothing
 * (N45, N52), so a cache never loads and nothing is written, but their
 * `clearAll` also empties the database, so data a SharedWorker session
 * stored cannot come back after a logout from any hosting.
 *
 * The clear-only call is `clearDisk` in the lazily loaded persistence chunk
 * (`persist/lazy.ts`): it is imported at the first `clearAll`, so a page
 * that never calls `clearAll` never loads it. The import counts against the
 * clear's deadline (`timeoutMs`, as for a load, §4.10.8), and the deadline
 * has one owner at a time: a timer while the chunk is loading, `clearDisk`
 * once it has arrived, so the call answers after any connection it opened
 * is closed. An import that arrives after the deadline is dropped and starts
 * no disk work (and `clearDisk` checks the deadline before it opens the
 * database in any case). A failed clear changes nothing else: this hosting
 * never reads or writes the disk, so there is nothing in it to turn off,
 * and the next `clearAll` tries again.
 */

import type { Engine } from "../engine/engine";
import type { Persistence } from "../rpc/server";
import type { OpenStore } from "./hosted";
import type { clearDisk, openIdbStore } from "./lazy";

/** The lazily loaded chunk's exports, as this module uses them. */
export interface ClearChunk {
  clearDisk: typeof clearDisk;
}

export class ClearOnlyPersistence implements Persistence {
  readonly #engine: Engine;
  readonly #load: () => Promise<ClearChunk>;
  readonly #openStore: OpenStore;
  readonly #options: { debounceMs?: number; timeoutMs?: number };
  readonly #timeoutMs: number;

  /**
   * `load` imports the chunk, at each `clearAll` (the module system keeps
   * it once loaded). `timeoutMs` bounds the import and the clear together.
   */
  constructor(
    engine: Engine,
    load: () => Promise<ClearChunk>,
    openStore: OpenStore,
    options: { debounceMs?: number; timeoutMs?: number } = {},
  ) {
    this.#engine = engine;
    this.#load = load;
    this.#openStore = openStore;
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /** Nothing loads: `persist: true` does nothing in this hosting (N45). */
  open(_cacheId: string): Promise<void> {
    return Promise.resolve();
  }

  /** No removal is ever written here, so no op waits. */
  durably(_cacheId: string, op: () => unknown): unknown {
    return op();
  }

  /**
   * Empties every cache in this call (N22), then the disk; answers once the
   * clear settled, at most `timeoutMs` after the call. A listener error of
   * the engine's clear is rethrown then.
   */
  clearAll(): Promise<void> {
    let failure: { error: unknown } | undefined;
    try {
      this.#engine.clearAll();
    } catch (error) {
      // Every cache was cleared anyway (N22); the disk must follow.
      failure = { error };
    }
    const startedAt = performance.now();
    // One owner of the deadline at a time. Until the chunk arrives, the
    // import timer owns it; no connection can exist yet, so answering at it
    // leaves nothing open. When the chunk arrives in time, the timer is
    // cleared and `clearDisk` owns the deadline: the call answers when it
    // resolves, which is after it has closed its connection. A chunk that
    // arrives after the timer fired is dropped: that call has ended.
    const cleared = new Promise<void>((resolve) => {
      let timedOut = false;
      const importTimer = setTimeout(() => {
        timedOut = true;
        resolve();
      }, this.#timeoutMs);
      this.#load()
        .then((chunk) => {
          if (timedOut) return;
          clearTimeout(importTimer);
          return chunk.clearDisk(this.#openStore, {
            ...this.#options,
            startedAt,
          });
        })
        .then(resolve, resolve);
    });
    return cleared.then(() => {
      if (failure !== undefined) throw failure.error;
    });
  }

  /** Nothing is ever written here. */
  flush(): void {}
}

/**
 * IndexedDB through the lazily loaded chunk's adapter, when this realm has
 * it (§4.10.8). Only its presence is checked here; the factory is read when
 * the store first opens, since the getter costs a worker's start time and
 * a hosting that never touches the disk never needs it.
 */
export function lazyIdbStore(
  load: () => Promise<{ openIdbStore: typeof openIdbStore }>,
): OpenStore | undefined {
  if (!("indexedDB" in globalThis)) return undefined;
  return (options) =>
    load().then((chunk) =>
      chunk.openIdbStore(
        (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB,
        options,
      ),
    );
}
