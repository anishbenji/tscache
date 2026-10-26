// The browser's client: the worker and the fetcher as Vite serves them,
// with the stored access token as the fetcher's context. A client that
// replaces a lost one is created the same way, with the token stored then.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { fetcherContext } from "@reference/shared/auth";
import { createClient, type TscacheClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";

export async function openClient(): Promise<TscacheClient> {
  return createClient({
    workerUrl,
    fetcher: { module: fetcherModule, context: await fetcherContext() },
  });
}
