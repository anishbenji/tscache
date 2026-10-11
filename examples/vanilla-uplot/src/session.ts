// What both pages share: a tscache client that is replaced when its worker
// is lost, and a log of what the backend and the cache did.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { onFetchNotice } from "@examples/mock-backend/notices";
import { createClient, type TscacheClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";

/**
 * Calls `use` with a connected client, and again with a new one whenever
 * the worker behind the current one is lost, as when the tab hosting the
 * SharedWorker crashes (docs/guides/worker-setup.md). The new client starts
 * a new worker, with an empty cache.
 */
export async function keepClient(
  use: (client: TscacheClient) => Promise<void>,
): Promise<void> {
  const client = await createClient({
    workerUrl,
    fetcher: { module: fetcherModule },
  });
  client.on("workerLost", ({ reason }) => {
    log(`worker lost (${reason}); connecting a new client`);
    void keepClient(use);
  });
  client.on("cacheCleared", ({ cacheId, reason }) => {
    log(`cache ${cacheId} cleared (${reason})`);
  });
  await use(client);
}

/** Shows a value in the page's `<output data-testid=…>`. */
export function show(name: string, value: string | number): void {
  const output = document.querySelector(`[data-testid="${name}"]`);
  if (output) output.textContent = String(value);
}

const time = (t: number) => new Date(t).toLocaleTimeString();
const moment = (t: number) =>
  new Date(t).toLocaleString([], { dateStyle: "short", timeStyle: "medium" });

export function log(line: string): void {
  const list = document.querySelector("#log");
  if (!list) return;
  const item = document.createElement("li");
  item.textContent = `${time(Date.now())}  ${line}`;
  list.prepend(item);
  list.querySelector("li:nth-child(51)")?.remove();
}

/**
 * Counts the backend fetches made by any tab of this origin. With a
 * SharedWorker, all tabs share one cache, so a range one tab fetched is
 * not fetched again for another.
 */
export function watchFetches(): void {
  let count = 0;
  onFetchNotice(({ cacheId, range, pages, outcome }) => {
    show("fetches", ++count);
    const span = `${moment(range.start)} – ${moment(range.end)}`;
    log(`fetched ${cacheId} ${span}: ${outcome}, ${pages} page(s)`);
  });
}

/** A uPlot width that fits the page. */
export function chartWidth(): number {
  return Math.min(document.body.clientWidth, 1024);
}
