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
} from "@anishbenji/tscache";
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
    try {
      const seed = decodeSnapshot(JSON.parse(text) as EncodedSnapshot);
      const { applied, skipped } = await cache.hydrate(seed);
      console.log(applied, skipped); // skipped: "version-mismatch" when refused
    } catch (error) {
      // Not seeded: hydration saves fetches and is never needed for correct
      // answers, so the read below fetches instead. A worker from before
      // hydrate (a stale cached script) refuses the op; any other failure
      // is worth a warning in development, with the message only, since
      // the snapshot carries the page's data.
      const old =
        error instanceof TscacheError && error.message === "unknown op hydrate";
      if (!old && development()) {
        const why = error instanceof Error ? error.message : String(error);
        console.warn(`snapshot not applied (${why}); the cache fetches`);
      }
    }
  }
  return cache.get(range);
}

// Bundlers replace the exact text `process.env.NODE_ENV` at build time, so
// it is read bare; a page that no bundler prepared has no `process`.
declare const process: { env: { NODE_ENV?: string } };

/** Whether this is a development build. */
function development(): boolean {
  try {
    return process.env.NODE_ENV !== "production";
  } catch {
    return false;
  }
}
// #endregion browser
