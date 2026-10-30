// The browser's half of server rendering: apply the server's snapshot,
// then read live.
// #region browser
import {
  type ClientOptions,
  createClient,
  decodeSnapshot,
  type EncodedSnapshot,
  type GetResult,
  type Range,
  TscacheError,
} from "tscache";
import { candles } from "./snapshots-server";

/**
 * Starts the page's cache from the server's snapshot (the JSON text of its
 * script element), then reads `range`, which fetches only what the
 * snapshot did not cover. `options` carry the worker URL and the fetcher:
 * the browser's client loads what the snapshot lacks.
 */
export async function startCache(
  options: ClientOptions,
  range: Range,
  text: string | null | undefined,
): Promise<GetResult> {
  const client = await createClient(options);
  const cache = await client.cache(candles);
  if (text != null) {
    const seed = decodeSnapshot(JSON.parse(text) as EncodedSnapshot);
    try {
      const { applied, skipped } = await cache.hydrate(seed);
      console.log(applied, skipped); // skipped: "version-mismatch" when refused
    } catch (error) {
      // A worker from before hydrate (a stale cached script) refuses the op:
      // nothing was applied, and the read below fetches instead.
      const old =
        error instanceof TscacheError && error.message === "unknown op hydrate";
      if (!old) throw error;
    }
  }
  return cache.get(range);
}
// #endregion browser
