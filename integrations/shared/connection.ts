// The client's lifecycle, the same in every framework: connect once,
// replace the client when the worker behind it is lost, dispose on
// teardown. A framework adapter turns `state` into its own reactivity (a
// store, a signal, a ref) and reads through `cache()`; the rest of its job
// is turning the read's promise into that reactivity too.

import type { CacheConfig, CacheHandle, TscacheClient } from "tscache";
import { hydrateRead, type ServerRead } from "./hydration";

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
   * one cache is the library's call, never this code's. On every client, a
   * cache's seed goes in before its first handle is given out, so no read
   * runs ahead of it.
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
 * Every client gets the seeds, a replacement's empty worker included:
 * `hydrate` refuses a snapshot of another dataset version and never
 * touches what a cache covers, so a page-old seed cannot replace newer
 * data (N39). Each seed is applied once per client, when its cache is
 * first asked for, into the cache opened with the seed's own config: a
 * reader asking for a conflicting config is refused by the client's check,
 * rather than handed coverage read on another grid.
 */
export function connect(
  open: () => Promise<TscacheClient>,
  seeds: readonly Seed[] = [],
): Connection {
  let state = CONNECTING;
  let disposed = false;
  const byId = new Map(seeds.map((seed) => [seed.config.id, seed]));
  /** Per client, the applying of each cache's seed, started on the first ask. */
  const seedings = new WeakMap<TscacheClient, Map<string, Promise<void>>>();
  const listeners = new Set<() => void>();

  function set(next: ConnectionState): void {
    state = next;
    for (const listener of listeners) listener();
  }

  function start(): void {
    open().then(
      (client) => {
        if (disposed) return void client.dispose();
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

  /** The applying of cache `id`'s seed to `client`, started on the first ask. */
  function seeding(
    client: TscacheClient,
    id: string,
  ): Promise<void> | undefined {
    const seed = byId.get(id);
    if (seed === undefined) return undefined;
    let ofClient = seedings.get(client);
    if (ofClient === undefined) {
      ofClient = new Map();
      seedings.set(client, ofClient);
    }
    let applying = ofClient.get(id);
    if (applying === undefined) {
      applying = client
        .cache(seed.config)
        .then((cache) => hydrateRead(cache, seed.read))
        .then(() => {});
      ofClient.set(id, applying);
    }
    return applying;
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
