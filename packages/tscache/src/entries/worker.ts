// './worker' entry — worker hosting shell (docs/architecture.md §4, §4.7).
// Dedicated Worker: the worker global itself is the port, attached at load
// (messages posted before the page listens are buffered by the browser).
// SharedWorker: one server, each connecting port attached once the
// worker holds its lifetime lock (N32), whose name hello reports. Only the
// SharedWorker persists (§4.10.8, N52): one engine is then the only writer
// of its origin's database. The persister and the IndexedDB adapter are a
// chunk of their own, loaded at the first persisted cache. The dedicated
// worker persists nothing, but its clearAll empties the database too, with
// the clear-only call of the same chunk (§4.10.7, N66).
// Deploy skew (§4.7, step 135): a SharedWorker joins the workers' channel
// before it attaches a port, announces itself after its first init, is
// superseded by a higher-ranked worker of another generation, and clears
// when another worker's clearAll arrives. Every hosting posts its clearAll.

import { Engine } from "../engine/engine";
import { ClearOnlyPersistence, lazyIdbStore } from "../persist/clear-only";
import { HostedPersistence, type OpenStore } from "../persist/hosted";
import type { PersisterOptions } from "../persist/persister";
import { randomId } from "../random-id";
import {
  clearPoster,
  Generations,
  openWorkersChannel,
  type WorkersChannel,
} from "../rpc/generations";
import { holdLifetimeLock, lockManager } from "../rpc/lifetime";
import { LIB_VERSION, type MessagePortLike } from "../rpc/protocol";
import { RpcServer } from "../rpc/server";

/** The dedicated-worker global, when this module runs inside one. */
function dedicatedWorkerScope(): MessagePortLike | undefined {
  const scope = globalThis as unknown as Partial<MessagePortLike> & {
    onconnect?: unknown;
    importScripts?: unknown;
  };
  // Only worker globals have importScripts; a SharedWorker scope also has
  // onconnect.
  const dedicated =
    typeof scope.importScripts === "function" && !("onconnect" in scope);
  return dedicated ? (scope as MessagePortLike) : undefined;
}

/** The lazily loaded persistence chunk (persist/lazy.ts). */
const lazyPersist = () => import("../persist/lazy");

/**
 * A SharedWorker among the workers of its origin (§4.7, Generations): the
 * channel they share, already open, and what this worker announces on it.
 */
export interface SharedIdentity {
  channel: WorkersChannel;
  /** The worker script's URL (`self.location.href`). */
  url: string;
  /** The SharedWorker's name, its generation key (N106). */
  name?: string;
  /** The worker's `performance.timeOrigin`. */
  startedAt: number;
  /** Default: `LIB_VERSION`. */
  lib?: string;
}

/**
 * Builds the engine and server; exported for tests. With `openStore`, the
 * server persists through a lazily loaded Persister whose stops it
 * broadcasts (§4.10.8), or, with `clearOnly`, persists nothing and only
 * empties the database at `clearAll` (§4.10.7, N66), posting that clear to
 * the SharedWorkers of the origin (N116). With `shared`, the SharedWorker's
 * server takes part in the workers' channel: it announces itself after its
 * first init under `lock` as its id (a random id without one), reports a
 * newer generation, posts its own clearAll and clears for another's.
 */
export function createServer(
  lock?: string,
  openStore?: OpenStore,
  options?: Omit<PersisterOptions, "onStopped">,
  clearOnly = false,
  shared?: SharedIdentity,
): RpcServer {
  const engine = new Engine();
  if (clearOnly) {
    if (openStore === undefined) {
      return new RpcServer(engine, LIB_VERSION, lock);
    }
    const post = clearPoster();
    const persistence = new ClearOnlyPersistence(
      engine,
      lazyPersist,
      openStore,
      { ...options, ...(post === undefined ? {} : { post }) },
    );
    return new RpcServer(engine, LIB_VERSION, lock, persistence);
  }
  let server: RpcServer | undefined;
  const generations =
    shared === undefined
      ? undefined
      : new Generations(
          shared.channel,
          {
            id: lock ?? randomId(),
            lib: shared.lib ?? LIB_VERSION,
            url: shared.url,
            startedAt: shared.startedAt,
            ...(shared.name === undefined ? {} : { name: shared.name }),
          },
          {
            superseded: (lib) => server?.supersede({ lib }),
            clearAll: (clearId) => server?.channelClear(clearId),
          },
        );
  const persistence =
    openStore === undefined
      ? undefined
      : new HostedPersistence(engine, lazyPersist, openStore, {
          ...options,
          onStopped: (event) => server?.persistStopped(event),
          ...(generations === undefined
            ? {}
            : { post: (clearId: string) => generations.postClear(clearId) }),
        });
  server = new RpcServer(
    engine,
    LIB_VERSION,
    lock,
    persistence,
    generations === undefined
      ? {}
      : { onFirstInit: (fetcher) => generations.announce(fetcher) },
  );
  return server;
}

/** The SharedWorker global, when this module runs inside one. */
function sharedWorkerScope():
  | {
      addEventListener(
        type: "connect",
        fn: (e: { ports: MessagePortLike[] }) => void,
      ): void;
    }
  | undefined {
  const scope = globalThis as unknown as {
    onconnect?: unknown;
    importScripts?: unknown;
  };
  const shared =
    typeof scope.importScripts === "function" && "onconnect" in scope;
  return shared ? (globalThis as never) : undefined;
}

const dedicated = dedicatedWorkerScope();
if (dedicated !== undefined) {
  createServer(undefined, lazyIdbStore(lazyPersist), undefined, true).attach(
    dedicated,
  );
}

const shared = sharedWorkerScope();
if (shared !== undefined) {
  // One engine for every tab that connects. The listener goes on now, so no
  // connection is missed; ports that arrive before the lifetime lock is held
  // wait for it, so every hello can name the lock.
  let server: RpcServer | undefined;
  const waiting: MessagePortLike[] = [];
  shared.addEventListener("connect", (event) => {
    for (const port of event.ports) {
      if (server === undefined) waiting.push(port);
      else server.attach(port);
    }
  });
  void holdLifetimeLock(lockManager()).then((lock) => {
    // The channel is open before any port is attached, so before any
    // init-ok: a clearAll posted from now on reaches this worker before it
    // can read the disk (§4.10.7).
    const channel = openWorkersChannel();
    const scope = globalThis as unknown as {
      location?: { href?: string };
      name?: unknown;
    };
    const ready = createServer(
      lock,
      lazyIdbStore(lazyPersist),
      undefined,
      false,
      channel === undefined
        ? undefined
        : {
            channel,
            url: String(scope.location?.href ?? ""),
            startedAt: performance.timeOrigin,
            ...(typeof scope.name === "string" ? { name: scope.name } : {}),
          },
    );
    server = ready;
    for (const port of waiting.splice(0)) ready.attach(port);
  });
}
