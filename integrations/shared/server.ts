// The server's client: in-process, since a server has no workers, and one
// per server process, so a render reads what earlier renders fetched.

import { type ClientOptions, createClient, type TscacheClient } from "tscache";

/**
 * A function giving this process's client, which the first call creates
 * and every later call shares. A failed start is not kept: the next call
 * tries again. Every visitor reads the same cache, so use it for public
 * data only; data that differs per user must not share a server cache.
 *
 * A server has no page origin: a fetcher that requests relative paths
 * needs the backend's origin in its `context`.
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
