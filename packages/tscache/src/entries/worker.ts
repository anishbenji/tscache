// './worker' entry — worker hosting shell (docs/architecture.md §4, §4.7).
// Dedicated Worker: the worker global itself is the port, attached at load
// (messages posted before the page listens are buffered by the browser).
// SharedWorker: one server, each connecting port attached.

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
  // Only worker globals have importScripts; a SharedWorker scope also has
  // onconnect and is handled at step ⑩.
  const dedicated =
    typeof scope.importScripts === "function" && !("onconnect" in scope);
  return dedicated ? (scope as MessagePortLike) : undefined;
}

/** Builds the engine and server; exported for tests and for step ⑩. */
export function createServer(): RpcServer {
  return new RpcServer(new Engine(), LIB_VERSION);
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
  // One engine for every tab that connects.
  const server = createServer();
  shared.addEventListener("connect", (event) => {
    for (const port of event.ports) server.attach(port);
  });
}
