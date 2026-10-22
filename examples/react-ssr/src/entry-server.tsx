// The page's server side. One in-process tscache client serves every render
// of this server process, so the history one render fetched, the next reads
// from memory. Each render reads the last half-year, renders the page from
// it and writes the covered parts of the answer into the page, for the
// browser's cache to start from.

import type { ExampleContext } from "@examples/mock-backend/fetcher";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import {
  dehydrate,
  hydrationScript,
  jsonScript,
  snapshotOf,
} from "@examples/mock-backend/hydration";
import type { RenderedPage, RenderRequest } from "@examples/mock-backend/vite";
import { renderToString } from "react-dom/server";
import { createClient, type TscacheClient } from "tscache";
import { APP_PROPS, App, type AppProps } from "./App";
import { candles, coveredBars, HALF_YEAR, summarize } from "./candles";

let shared: Promise<TscacheClient> | undefined;

/**
 * The process's client, created by the first render. Its cache is shared by
 * every visitor, which suits public data only. A failed creation is
 * forgotten, so the next render tries again.
 */
function serverClient(origin: string): Promise<TscacheClient> {
  shared ??= createClient({
    mode: "in-process",
    fetcher: {
      module: fetcherModule,
      context: { origin } satisfies ExampleContext,
    },
  }).catch((error: unknown) => {
    shared = undefined;
    throw error;
  });
  return shared;
}

// In dev, an edit makes Vite reload the server modules (it calls no dispose
// handler then); the old client goes first.
import.meta.hot?.on("vite:beforeFullReload", () => {
  const old = shared;
  shared = undefined;
  void old?.then(
    (client) => client.dispose(),
    () => {},
  );
});

export async function render({ origin }: RenderRequest): Promise<RenderedPage> {
  const cache = await (await serverClient(origin)).cache(candles);
  const now = Date.now();
  const range = { start: now - HALF_YEAR, end: now };
  // What the cache held before this render, for the page to tell.
  const known = await cache.get(range, { cacheOnly: true });
  // The page's summary and its snapshot come from one read (N36).
  const result = await cache.get(range, { snapshot: true });
  // The page shows what the cache has; the browser fetches the rest itself.
  // The provisional day is always an 'uncached' miss; any other is news.
  for (const { reason, range: missed } of result.misses) {
    if (reason !== "uncached") {
      console.warn(`tscache: ${reason} miss for ${JSON.stringify(missed)}`);
    }
  }
  const props: AppProps = {
    range,
    summary: summarize(result),
    serverCached: coveredBars(known),
  };
  const hydration = dehydrate(range, snapshotOf(result));
  return {
    head: hydrationScript(hydration) + jsonScript(APP_PROPS, props),
    html: renderToString(<App {...props} hydration={hydration} />),
  };
}
