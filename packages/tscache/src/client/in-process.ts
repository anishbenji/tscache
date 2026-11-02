/**
 * The in-process hosting (docs/architecture.md §4.8, N27): an Engine and
 * its RpcServer in this realm. The fallback chain loads this module with
 * `import()` only when it reaches the in-process hosting, so a page served
 * by a worker never downloads or parses the engine. It persists nothing
 * (N52), but where the realm has IndexedDB its clearAll empties the
 * database too, with the clear-only call of the persistence chunk, loaded
 * at the first clearAll (§4.10.7, N66).
 */

import { Engine } from "../engine/engine";
import { ClearOnlyPersistence, lazyIdbStore } from "../persist/clear-only";
import { PortClient } from "../rpc/port-client";
import type { FetcherConfig, MessagePortLike } from "../rpc/protocol";
import { RpcServer } from "../rpc/server";
import type { Hosting } from "./hosting";

/** Library version reported by the in-process server. */
const LIB_VERSION = "0.0.0";

/** The persistence chunk (persist/lazy.ts), for the clear-only call. */
const lazyPersist = () => import("../persist/lazy");

/** A MessageChannel pair with its own Engine in this realm (N27, §3.2). */
export async function connectInProcess(
  fetcher: FetcherConfig | undefined,
): Promise<Hosting> {
  const channel = new MessageChannel();
  const engine = new Engine();
  const openStore = lazyIdbStore(lazyPersist);
  const server = new RpcServer(
    engine,
    LIB_VERSION,
    undefined,
    openStore === undefined
      ? undefined
      : new ClearOnlyPersistence(engine, lazyPersist, openStore),
  );
  server.attach(channel.port1 as MessagePortLike);
  const client = await PortClient.connect(
    channel.port2 as MessagePortLike,
    fetcher === undefined ? {} : { fetcher },
  );
  return {
    mode: "in-process",
    client,
    terminate: () => server.detach(channel.port1 as MessagePortLike),
  };
}
