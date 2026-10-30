import { type ClientOptions, createClient, type TscacheClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";
import fetcherModule from "./fetcher.ts?fetcher";

// #region options
const options: ClientOptions = {
  workerUrl,
  // Where the chain starts: "shared" (default), "dedicated" or "in-process".
  mode: "shared",
  // How long a hosting may take to say hello before the chain steps down.
  handshakeTimeoutMs: 5000,
  fetcher: { module: fetcherModule, context: { token: "initial-token" } },
};
const client = await createClient(options);
// #endregion options

// #region fallback
client.on("modeFallback", ({ from, to, reason }) => {
  console.warn(`tscache: ${from} failed (${reason}); using ${to}`);
});
// #endregion fallback

// #region in-process
// No worker at all: server code, Node, tests. Each such client has an
// engine of its own.
const local = await createClient({ mode: "in-process" });
// #endregion in-process

// #region lost
let current: TscacheClient = client;
function recover(): void {
  void createClient(options).then((next) => {
    current = next;
    current.on("workerLost", recover);
  });
}
current.on("workerLost", recover);
// #endregion lost

// #region auth
const stop = client.on("authInvalid", ({ context }) => {
  console.log("refused context", context);
  // Refresh the credential, then hand it to the fetcher in every worker.
  void client.updateAuth({ token: "fresh-token" });
});
stop(); // on() returns the unsubscribe; off(event, fn) works too
// #endregion auth

// #region clear-all
// Empties every cache of the worker: with a SharedWorker, for every tab.
await client.clearAll();
// #endregion clear-all

// #region dispose
await local.dispose(); // idempotent; later calls reject with TscacheError
// #endregion dispose
