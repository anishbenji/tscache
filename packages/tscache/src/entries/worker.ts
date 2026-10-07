// './worker' entry — worker hosting shell (docs/architecture.md §4, §4.7).
// Dedicated Worker: the worker global itself is the port, attached at load
// (messages posted before the page listens are buffered by the browser).
// SharedWorker (onconnect) arrives at step ⑩.

import { Engine } from "../engine/engine";
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
  const isWorker =
    typeof scope.importScripts === "function" &&
    typeof scope.postMessage === "function" &&
    typeof scope.addEventListener === "function";
  // A SharedWorker scope has onconnect; it is handled at step ⑩.
  if (!isWorker || "onconnect" in scope) return undefined;
  return scope as MessagePortLike;
}

/** Builds the engine and server; exported for tests and for step ⑩. */
export function createServer(): RpcServer {
  return new RpcServer(new Engine(), LIB_VERSION);
}

const scope = dedicatedWorkerScope();
if (scope !== undefined) createServer().attach(scope);
