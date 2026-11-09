import type { TscacheClient } from "@anishbenji/tscache";

const MINUTE = 60_000;

// #region opt-in
export async function openCandles(client: TscacheClient) {
  const cache = await client.cache({
    id: "candles/ACME/1m",
    interval: MINUTE,
    fields: { close: "f64", volume: "f64" },
    version: "2026-10", // stored records of another version are never loaded
    persist: true, // kept in IndexedDB when the client is hosted 'shared'
  });
  // Elsewhere (dedicated, in-process, Node) the flag does nothing.
  const persisted =
    client.mode === "shared" && typeof indexedDB !== "undefined";
  return { cache, persisted };
}
// #endregion opt-in

// #region stopped
export function watchPersistence(client: TscacheClient): () => void {
  // A stop while cache() loads comes before the handle exists: listen on
  // the client. The cache goes on in memory.
  return client.on("persistStopped", ({ cacheId, reason, error }) => {
    console.warn(`${cacheId} is no longer persisted (${reason})`, error);
  });
}
// #endregion stopped

// #region storage
export async function keepStorage(): Promise<boolean> {
  // Best-effort storage can be evicted under pressure; ask to keep it.
  // Some browsers prompt the user, so tscache never asks on its own.
  return (await navigator.storage?.persist?.()) ?? false;
}
// #endregion storage

// #region logout
export async function logout(client: TscacheClient): Promise<void> {
  // Empties every cache and, from a client of any hosting, the database
  // too: resolves once the records are gone, or the clear gave up.
  await client.clearAll();
}
// #endregion logout
