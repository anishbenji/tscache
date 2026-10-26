// The server-rendered page, the server's half. One in-process client
// serves every render of this server process, so what one render fetched
// the next reads from memory. The server reads the page's opening range
// and writes the answer into the page twice: as markup, and as data the
// browser starts its cache from (entry-client.ts).

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import type { RenderedPage, RenderRequest } from "@examples/mock-backend/vite";
import {
  market,
  openingRange,
  readRange,
  summarize,
} from "@reference/shared/market";
import { SERVICE_TOKEN } from "@reference/shared/server";
import {
  dehydrate,
  jsonScript,
  SERVER_READ,
  type ServerRead,
} from "@tscache/integrations/shared/hydration";
import { serverReader } from "@tscache/integrations/shared/server";
import type { CacheConfig, Range } from "tscache";
import { pageMarkup } from "./page";

type Reader = (config: CacheConfig, range: Range) => Promise<ServerRead>;

/** The process's reader, created by the first render with its origin. */
let reader: Reader | undefined;

export async function render({ origin }: RenderRequest): Promise<RenderedPage> {
  reader ??= serverReader({
    fetcherModule,
    origin,
    context: { token: SERVICE_TOKEN },
  });
  const now = Date.now();
  const read = await reader(market, readRange(openingRange(now), now));
  return {
    head: jsonScript(SERVER_READ, dehydrate(read)),
    html: pageMarkup(summarize(read.result)),
  };
}
