// './worker' entry — worker hosting shell (docs/architecture.md §4, §4.7).
// Dedicated Worker: the worker global itself is the port, attached at load
// (messages posted before the page listens are buffered by the browser).
// SharedWorker: one server, each connecting port attached once the
// worker holds its lifetime lock (N32), whose name hello reports.

import { Engine } from "../engine/engine";
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

/** Builds the engine and server; exported for tests. */
export function createServer(lock?: string): RpcServer {
  return new RpcServer(new Engine(), LIB_VERSION, lock);
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
    const ready = createServer(lock);
    server = ready;
    for (const port of waiting.splice(0)) ready.attach(port);
  });
}
