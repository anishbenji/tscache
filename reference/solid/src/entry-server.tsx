// The server-rendered page, the server's half. One in-process client
// serves every render of this server process, so what one render fetched
// the next reads from memory. The server reads before it renders, so
// nothing is async inside the render and renderToString writes the
// finished markup in one pass. The read goes into the page a second time
// as data, for the browser's half (entry-client.tsx).

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import type { RenderedPage, RenderRequest } from "@examples/mock-backend/vite";
import { chartKindOf } from "@reference/shared/chart/load";
import { market, openingRange, readRange } from "@reference/shared/market";
import { SERVICE_TOKEN } from "@reference/shared/server";
import { generateHydrationScript, renderToString } from "@solidjs/web";
import {
  dehydrate,
  jsonScript,
  SERVER_READ,
  type ServerRead,
} from "@tscache/integrations/shared/hydration";
import { serverReader } from "@tscache/integrations/shared/server";
import type { CacheConfig, Range } from "tscache";
import { App } from "./App";

type Reader = (config: CacheConfig, range: Range) => Promise<ServerRead>;

/** The process's reader, created by the first render with its origin. */
let reader: Reader | undefined;

export async function render({
  origin,
  url,
}: RenderRequest): Promise<RenderedPage> {
  reader ??= serverReader({
    fetcherModule,
    origin,
    context: { token: SERVICE_TOKEN },
  });
  const now = Date.now();
  const served = await reader(market, readRange(openingRange(now), now));
  const kind = chartKindOf(new URL(url, origin).search);
  return {
    // Solid's hydration script first: the browser's hydrate needs it.
    head:
      generateHydrationScript() + jsonScript(SERVER_READ, dehydrate(served)),
    html: renderToString(() => (
      <App session={null} served={served} initialKind={kind} />
    )),
  };
}
