// The server's half of server rendering: read with an in-process client,
// write the columns and the snapshot into the page.
// #region server
import {
  type CacheConfig,
  createClient,
  encodeSnapshot,
  type Range,
} from "tscache";
import type { Context } from "./fetcher";

export const candles: CacheConfig = {
  id: "crypto/BTC",
  interval: 60_000,
  fields: { open: "f64", high: "f64", low: "f64", close: "f64", volume: "u32" },
};

export interface ServerOptions {
  /** The fetcher module as a URL the server can import(). */
  fetcherModule: string;
  /** The backend's origin: a server has no page origin to resolve against. */
  origin: string;
}

/**
 * The page renderer of this server process. Create it once at startup: it
 * owns the process's one client, so a render reads what earlier renders
 * fetched. Every visitor reads the same cache: public data only.
 */
export async function createRenderer({ fetcherModule, origin }: ServerOptions) {
  const context: Context = { origin };
  const client = await createClient({
    mode: "in-process", // a server has no workers
    fetcher: { module: fetcherModule, context },
  });
  const cache = await client.cache(candles);
  return async (range: Range): Promise<string> => {
    // One read gives the page's columns and the cache's snapshot.
    const { snapshot, ...result } = await cache.get(range, { snapshot: true });
    if (snapshot === undefined) throw new Error("the read carries no snapshot");
    // Escape every "<" so no string can close the script element.
    const json = JSON.stringify(encodeSnapshot(snapshot)).replaceAll(
      "<",
      "\\u003c",
    );
    return `<p id="chart">${result.timestamps.length} candles</p>
<script id="tscache-snapshot" type="application/json">${json}</script>`;
  };
}
// #endregion server
