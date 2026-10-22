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

/**
 * Its members need no `this`: pass `subscribe`, or a getter of `state`,
 * as they are (React's useSyncExternalStore takes them so).
 */
export interface Connection {
  readonly state: ConnectionState;
  /** Calls `listener` after each change of `state`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * `client`'s handle for `config`. Every call goes to `client.cache()`,
   * which opens the same cache for an equal config and rejects a
   * conflicting one with ConfigError (N4, N20): whether two configs name
   * one cache is the library's call, never this code's. On the first
   * client, a cache's seed goes in before its first handle is given out,
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
 * version to tell. Each seed is put once, when its cache is first asked
 * for, into the cache opened with the seed's own config: a reader asking
 * for a conflicting config is refused by the client's check, rather than
 * handed coverage read on another grid.
 */
export function connect(
  open: () => Promise<TscacheClient>,
  seeds: readonly Seed[] = [],
): Connection {
  let state = CONNECTING;
  let disposed = false;
  const unseeded = new Map(seeds.map((seed) => [seed.config.id, seed]));
  const seedings = new Map<string, Promise<void>>();
  let first: TscacheClient | undefined;
  const listeners = new Set<() => void>();

  function set(next: ConnectionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function start(): void {
    open().then(
      (client) => {
        if (disposed) return void client.dispose();
        first ??= client;
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

  /** The putting of the seed for cache `id`, started on the first ask. */
  function seeding(
    client: TscacheClient,
    id: string,
  ): Promise<void> | undefined {
    if (client !== first) return undefined;
    let putting = seedings.get(id);
    const seed = unseeded.get(id);
    if (putting === undefined && seed !== undefined) {
      unseeded.delete(id);
      putting = client
        .cache(seed.config)
        .then((cache) => putCovered(cache, seed.config, seed.read));
      seedings.set(id, putting);
    }
    return putting;
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
    async cache(client, config) {
      await seeding(client, config.id);
      return client.cache(config);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (state.status === "connected") await state.client.dispose();
    },
  };
}
