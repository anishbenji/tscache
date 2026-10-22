// The server's side: reads with an in-process client, since a server has
// no workers, and one client per server process, so a render reads what
// earlier renders fetched.

import {
  type CacheConfig,
  type ClientOptions,
  createClient,
  type Range,
  type TscacheClient,
} from "tscache";
import type { ServerRead } from "./hydration";

/**
 * A function giving this process's client, which the first call creates
 * and every later call shares. A failed start is not kept: the next call
 * tries again. Every visitor reads the same cache, so use it for public
 * data only; data that differs per user must not share a server cache.
 */
export function serverClient(
  options: Omit<ClientOptions, "mode" | "workerUrl"> = {},
): () => Promise<TscacheClient> {
  let shared: Promise<TscacheClient> | undefined;
  return () => {
    shared ??= createClient({ ...options, mode: "in-process" }).catch(
      (error: unknown) => {
        shared = undefined;
        throw error;
      },
    );
    return shared;
  };
}

export interface ServerOptions {
  /** The fetcher module as a URL the server can import(). */
  fetcherModule: string;
  /** The backend's origin: a server has no page origin to resolve against. */
  origin: string;
}

/**
 * Reads for this process's renders, through its {@link serverClient}, with
 * a fetcher whose context names the backend's origin. Create it once at
 * startup (docs/guides/worker-setup.md, "Server rendering").
 */
export function serverReader({
  fetcherModule,
  origin,
}: ServerOptions): (config: CacheConfig, range: Range) => Promise<ServerRead> {
  const client = serverClient({
    fetcher: { module: fetcherModule, context: { origin } },
  });
  return async (config, range) => {
    const cache = await (await client()).cache(config);
    return { range, result: await cache.get(range) };
  };
}
