// Renders the page on the server. One in-process tscache client serves every
// render of this server process, so a render reads from the cache the
// earlier ones filled and fetches only the minutes since. The sensor's
// readings are public, the same for every visitor; data that differs per
// user must not share a server cache.

import type { ExampleContext } from "@examples/mock-backend/fetcher";
import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import {
  dehydrate,
  hydrationScript,
  jsonScript,
} from "@examples/mock-backend/hydration";
import type { RenderedPage, RenderRequest } from "@examples/mock-backend/vite";
import { generateHydrationScript, renderToString } from "@solidjs/web";
import { createClient, type TscacheClient } from "tscache";
import { APP_PROPS, App } from "./App";
import { config, figuresOf, lastDay, type ServerRead } from "./sensor";

let shared: Promise<TscacheClient> | undefined;

/**
 * The process's client, created by the first render. The backend answers on
 * the server's own origin, which a server-side fetch has to be told.
 */
function serverClient(origin: string): Promise<TscacheClient> {
  shared ??= createClient({
    mode: "in-process",
    fetcher: {
      module: fetcherModule,
      context: { origin } satisfies ExampleContext,
    },
  }).catch((error: unknown) => {
    // The next render tries again.
    shared = undefined;
    throw error;
  });
  return shared;
}

// After a change, the dev server evaluates this module again, and with it a
// new client: release the old one first.
import.meta.hot?.on("vite:beforeFullReload", () => {
  const old = shared;
  shared = undefined;
  void old?.then(
    (client) => client.dispose(),
    () => {},
  );
});

export async function render({ origin }: RenderRequest): Promise<RenderedPage> {
  const range = lastDay(Date.now());
  const client = await serverClient(origin);
  const cache = await client.cache(config);
  const known = await cache.get(range, { cacheOnly: true });
  const result = await cache.get(range);
  // The page shows what the cache has; the browser fetches the rest itself.
  // The minute after now is always an 'uncached' miss; any other is news.
  for (const { reason, range: missed } of result.misses) {
    if (reason !== "uncached") {
      console.warn(`tscache: ${reason} miss for ${JSON.stringify(missed)}`);
    }
  }
  const props: ServerRead = {
    window: range,
    mode: client.mode,
    figures: figuresOf(result),
    cached: known.timestamps.length,
  };
  return {
    head:
      generateHydrationScript() +
      hydrationScript(dehydrate(range, result)) +
      jsonScript(APP_PROPS, props),
    html: renderToString(() => <App {...props} />),
  };
}
