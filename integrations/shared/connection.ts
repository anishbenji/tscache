// The client's lifecycle, the same in every framework: connect once,
// replace the client when the worker behind it is lost, dispose on
// teardown. A framework adapter turns `state` into its own reactivity (a
// store, a signal, a ref) and reads through `cache()`; the rest of its job
// is turning the read's promise into that reactivity too.

import type { CacheConfig, CacheHandle, TscacheClient } from "tscache";
import { putCovered, type ServerRead } from "./hydration";

/**
 * Where the connection stands. Every change is a new object, so a snapshot
 * compares by identity.
 */
export type ConnectionState =
  | { readonly status: "connecting" }
  | { readonly status: "connected"; readonly client: TscacheClient }
  | { readonly status: "failed"; readonly error: unknown };

/** A server's read of one cache, to start the browser's cache from. */
export interface Seed {
  config: CacheConfig;
  read: ServerRead;
}

export interface Connection {
  readonly state: ConnectionState;
  /** Calls `listener` after each change of `state`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * `client`'s handle for `config`, opened once per client and cache id.
   * The first client puts a cache's seed in before handing the cache out,
   * so no read runs ahead of it.
   */
  cache(client: TscacheClient, config: CacheConfig): Promise<CacheHandle>;
  /** Disposes the client and stops replacing it. Idempotent. */
  dispose(): Promise<void>;
}

const CONNECTING: ConnectionState = { status: "connecting" };

/**
 * Connects with `open`, and again each time the worker behind the client
 * is lost, as when the tab hosting the SharedWorker crashes: the new client
 * starts a new worker with an empty cache (docs/guides/worker-setup.md).
 * `open` runs once per client, so it can read the fetcher's current
 * credentials.
 *
 * Only the first client gets the seeds. A replacement starts empty and
 * fetches what it is asked for: the seeds are as old as the page, which
 * may have seen a newer dataset version since, and a seed carries no
 * version to tell.
 */
export function connect(
  open: () => Promise<TscacheClient>,
  seeds: readonly Seed[] = [],
): Connection {
  let state = CONNECTING;
  let disposed = false;
  let firstSeeds: Map<string, ServerRead> | undefined = new Map(
    seeds.map(({ config, read }) => [config.id, read]),
  );
  const seedsOf = new WeakMap<TscacheClient, Map<string, ServerRead>>();
  const handles = new WeakMap<
    TscacheClient,
    Map<string, Promise<CacheHandle>>
  >();
  const listeners = new Set<() => void>();

  function set(next: ConnectionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function start(): void {
    open().then(
      (client) => {
        if (disposed) return void client.dispose();
        if (firstSeeds !== undefined) {
          seedsOf.set(client, firstSeeds);
          firstSeeds = undefined;
        }
        client.on("workerLost", () => {
          if (disposed) return;
          set(CONNECTING);
          start();
        });
        set({ status: "connected", client });
      },
      (error: unknown) => {
        if (!disposed) set({ status: "failed", error });
      },
    );
  }

  function handlesOf(client: TscacheClient): Map<string, Promise<CacheHandle>> {
    let opened = handles.get(client);
    if (opened === undefined) {
      opened = new Map();
      handles.set(client, opened);
    }
    return opened;
  }

  async function openCache(
    client: TscacheClient,
    config: CacheConfig,
  ): Promise<CacheHandle> {
    const handle = await client.cache(config);
    const seeds = seedsOf.get(client);
    const read = seeds?.get(config.id);
    if (read !== undefined) {
      seeds?.delete(config.id);
      await putCovered(handle, config, read);
    }
    return handle;
  }

  start();
  return {
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cache(client, config) {
      const opened = handlesOf(client);
      let handle = opened.get(config.id);
      if (handle === undefined) {
        handle = openCache(client, config);
        opened.set(config.id, handle);
        // A failed open is not kept: the next call tries again.
        handle.catch(() => opened.delete(config.id));
      }
      return handle;
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (state.status === "connected") await state.client.dispose();
    },
  };
}
