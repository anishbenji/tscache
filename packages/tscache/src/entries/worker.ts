// './worker' entry — worker hosting shell (docs/architecture.md §4, §4.7).
// Dedicated Worker: the worker global itself is the port, attached at load
// (messages posted before the page listens are buffered by the browser).
// SharedWorker: one server, each connecting port attached once the
// worker holds its lifetime lock (N32), whose name hello reports. Only the
// SharedWorker persists (§4.10.8, N52): one engine is then the only writer
// of its origin's database. The persister and the IndexedDB adapter are a
// chunk of their own, loaded at the first persisted cache.

import { Engine } from "../engine/engine";
import { HostedPersistence, type OpenStore } from "../persist/hosted";
import type { PersisterOptions } from "../persist/persister";
import { holdLifetimeLock, lockManager } from "../rpc/lifetime";
import type { MessagePortLike } from "../rpc/protocol";
import { RpcServer } from "../rpc/server";

/** Library version reported in hello; replaced at build time later. */
const LIB_VERSION = "0.0.0";

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
 * Builds the engine and server; exported for tests. With `openStore`, the
 * server persists through a lazily loaded Persister whose stops it
 * broadcasts (§4.10.8).
 */
export function createServer(
  lock?: string,
  openStore?: OpenStore,
  options?: Omit<PersisterOptions, "onStopped">,
): RpcServer {
  const engine = new Engine();
  if (openStore === undefined) return new RpcServer(engine, LIB_VERSION, lock);
  let server: RpcServer | undefined;
  const persistence = new HostedPersistence(engine, lazyPersist, openStore, {
    ...options,
    onStopped: (event) => server?.persistStopped(event),
  });
  server = new RpcServer(engine, LIB_VERSION, lock, persistence);
  return server;
}

/**
 * IndexedDB, when this realm has it: what the SharedWorker persists to.
 * Only its presence is checked at start; the factory is read when the
 * store first opens, since the getter costs a worker's start time and an
 * app that persists nothing never needs it. The adapter is in the lazy
 * chunk, which the persister has loaded by then.
 */
function idbStore(): OpenStore | undefined {
  if (!("indexedDB" in globalThis)) return undefined;
  return (options) =>
    lazyPersist().then((chunk) =>
      chunk.openIdbStore(
        (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB,
        options,
      ),
    );
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
if (dedicated !== undefined) createServer().attach(dedicated);

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
    const ready = createServer(lock, idbStore());
    server = ready;
    for (const port of waiting.splice(0)) ready.attach(port);
  });
}
