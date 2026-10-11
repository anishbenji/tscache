// The tscache client, replaced when its worker is lost, and what the page
// reports: the backend fetch count and a log.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { onFetchNotice } from "@examples/mock-backend/notices";
import { createMemo, createSignal, refresh } from "solid-js";
import { createClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";

interface LogLine {
  at: number;
  text: string;
}

/** The newest 50 log lines, newest first. */
const [lines, setLines] = createSignal<LogLine[]>([]);

/**
 * The backend fetches any tab of this origin made. With a SharedWorker all
 * tabs share one cache, so a range one tab fetched is not fetched again for
 * another.
 */
const [fetches, setFetches] = createSignal(0);

export { fetches, lines };

export function log(text: string): void {
  setLines((all) => [{ at: Date.now(), text }, ...all].slice(0, 50));
}

/** UTC, like the chart's time axis. */
const utc = (t: number) =>
  new Date(t).toISOString().slice(0, 16).replace("T", " ");

function duration(ms: number): string {
  const hours = ms / 3_600_000;
  return hours < 48 ? `${hours} h` : `${(hours / 24).toFixed(1)} days`;
}

// Subscribed when the module loads, before the first get, so the count
// includes the first fetch.
onFetchNotice(({ cacheId, range, pages, outcome }) => {
  setFetches((n) => n + 1);
  const span = `${utc(range.start)} – ${utc(range.end)} UTC`;
  const length = duration(range.end - range.start);
  log(`fetched ${cacheId} ${span} (${length}): ${outcome}, ${pages} page(s)`);
});

/**
 * The connected client, as an async memo. When the worker behind it is
 * lost, as when the tab hosting the SharedWorker crashes
 * (docs/guides/worker-setup.md), the memo is refreshed: it connects a new
 * client, which starts a new worker with an empty cache, and everything
 * derived from the client follows.
 */
export function createTscacheClient() {
  const client = createMemo(async () => {
    const next = await createClient({
      workerUrl,
      fetcher: { module: fetcherModule },
    });
    next.on("workerLost", ({ reason }) => {
      log(`worker lost (${reason}); connecting a new client`);
      void refresh(client);
    });
    return next;
  });
  return client;
}
