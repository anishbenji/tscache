// './worker' entry — worker hosting shell (docs/architecture.md §4, §4.7).
// Dedicated Worker: the worker global itself is the port, attached at load
// (messages posted before the page listens are buffered by the browser).
// SharedWorker: one server, each connecting port attached once the
// worker holds its lifetime lock (N32), whose name hello reports. Only the
// SharedWorker persists (§4.10.8, N52): one engine is then the only writer
// of its origin's database.

import { Engine } from "../engine/engine";
import { openIdbStore } from "../persist/idb-store";
import { Persister, type PersisterOptions } from "../persist/persister";
import type { PersistStore } from "../persist/store";
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

type OpenStore = (options?: {
  ifExists?: boolean;
}) => Promise<PersistStore | undefined>;

/**
 * Builds the engine and server; exported for tests. With `openStore`, the
 * server persists through a Persister whose stops it broadcasts (§4.10.8).
 */
export function createServer(
  lock?: string,
  openStore?: OpenStore,
  options?: Omit<PersisterOptions, "onStopped">,
): RpcServer {
  const engine = new Engine();
  if (openStore === undefined) return new RpcServer(engine, LIB_VERSION, lock);
  let server: RpcServer | undefined;
  const persister = new Persister(engine, openStore, {
    ...options,
    onStopped: (event) => server?.persistStopped(event),
  });
  server = new RpcServer(engine, LIB_VERSION, lock, persister);
  return server;
}

/** IndexedDB, when this realm has it: what the SharedWorker persists to. */
function idbStore(): OpenStore | undefined {
  const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (factory === undefined) return undefined;
  return (options) => openIdbStore(factory, options);
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
