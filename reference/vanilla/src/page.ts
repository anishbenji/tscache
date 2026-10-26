// The page: a live candle chart of the market, without a framework.
//
// One connection serves the page (connect, from the integration snippets):
// it connects once, replaces the client when the worker behind it is lost,
// and starts each client's cache from the server's read when the page was
// rendered on the server. A series reads the range around what is on
// screen and keeps only the latest answer. Scrolling asks for the new
// range, and the cache fetches only what it does not hold. Pushed bars go
// into the cache (live.ts) and are read back from it alone, so a push
// costs no fetch. An expired token is refreshed once across tabs
// (auth.ts), and the reads it held back are asked again.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import {
  fetcherContext,
  refreshOnAuthInvalid,
  signInAgain,
} from "@reference/shared/auth";
import {
  type ChartKind,
  chartKindOf,
  loadChart,
} from "@reference/shared/chart/load";
import type { ChartView } from "@reference/shared/chart/view";
import { liveFeed } from "@reference/shared/live";
import {
  feedUrl,
  market,
  openingRange,
  readRange,
  summarize,
} from "@reference/shared/market";
import {
  type ConnectionState,
  connect,
} from "@tscache/integrations/shared/connection";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { series } from "@tscache/integrations/vanilla/series";
import { createClient, type GetResult, type Range } from "tscache";
import workerUrl from "tscache/worker?worker&url";

/** How long scrolling must pause before the new range is read. */
const SCROLL_PAUSE_MS = 150;

/**
 * The page's markup, as the server renders it and the client-only page
 * starts from. `summary` holds numbers only; escape anything with text.
 */
export function pageMarkup(summary: string): string {
  return `<header>
  <h1>BTC · one-minute candles</h1>
  <label>Chart
    <select id="chart-kind">
      <option value="lightweight">Lightweight Charts</option>
      <option value="uplot">uPlot</option>
    </select>
  </label>
</header>
<p class="status">
  <output data-testid="summary">${summary}</output> ·
  drawn <output data-testid="drawn">–</output> UTC ·
  mode <output data-testid="mode">…</output> ·
  <output data-testid="connection">connecting</output> ·
  <output data-testid="auth">signed in</output>
  <button type="button" id="sign-in" hidden>Sign in again</button>
</p>
<div id="chart" class="chart"></div>`;
}

function element<T extends HTMLElement>(
  root: HTMLElement,
  selector: string,
): T {
  const found = root.querySelector<T>(selector);
  if (found === null) throw new Error(`the page has no ${selector}`);
  return found;
}

function describe(state: ConnectionState): string {
  switch (state.status) {
    case "connecting":
      return "connecting";
    case "connected":
      return "live";
    case "failed":
      return `failed: ${state.error instanceof Error ? state.error.message : String(state.error)}`;
  }
}

/** A function that runs `fn` once calls to it pause for `ms`. */
function debounce<A extends unknown[]>(ms: number, fn: (...args: A) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const call = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  call.cancel = () => clearTimeout(timer);
  return call;
}

export interface PageOptions {
  /**
   * The server's read, when the server rendered the page: drawn before the
   * client connects, and the cache starts from it.
   */
  served?: ServerRead;
}

/**
 * Runs the page inside `root`, whose markup is pageMarkup()'s. Returns the
 * teardown; a page that simply closes needs none, since a client disposes
 * itself on `pagehide`.
 */
export function startPage(
  root: HTMLElement,
  { served }: PageOptions = {},
): () => Promise<void> {
  const chartElement = element<HTMLElement>(root, "#chart");
  const select = element<HTMLSelectElement>(root, "#chart-kind");
  const signIn = element<HTMLButtonElement>(root, "#sign-in");
  const output = (name: string) =>
    element<HTMLOutputElement>(root, `[data-testid="${name}"]`);

  const now = Date.now();
  const opening = openingRange(served?.range.end ?? now);
  /** The range the series reads: what is on screen, and a screen each side. */
  let asked = served?.range ?? readRange(opening, now);
  /** The latest answer, which a newly mounted chart draws at once. */
  let latest: GetResult | undefined = served?.result;
  let view: ChartView | undefined;
  let mounts = 0;
  let disposed = false;
  let sessionLost = false;

  const connection = connect(
    async () =>
      createClient({
        workerUrl,
        fetcher: { module: fetcherModule, context: await fetcherContext() },
      }),
    served === undefined ? [] : [{ config: market, read: served }],
  );

  function showAuth(result: GetResult): void {
    if (sessionLost) return;
    const pending = result.misses.some(
      (miss) => miss.reason === "auth-pending",
    );
    output("auth").value = pending ? "refreshing credentials" : "signed in";
  }

  const bars = series(connection, {
    config: market,
    render({ result }) {
      latest = result;
      view?.draw(result);
      output("summary").value = summarize(result);
      output("drawn").value = new Date().toISOString().slice(11, 19);
      showAuth(result);
    },
    fail(error) {
      output("connection").value = `read failed: ${String(error)}`;
    },
  });

  const onScroll = debounce(SCROLL_PAUSE_MS, (visible: Range) => {
    asked = readRange(visible, Date.now());
    bars.show(asked);
  });

  /** Shows the chart of `kind`, replacing the one shown. */
  async function mountChart(kind: ChartKind): Promise<void> {
    const mount = ++mounts;
    const create = await loadChart(kind);
    if (disposed || mount !== mounts) return;
    view?.dispose();
    chartElement.replaceChildren();
    view = create(chartElement, { interval: market.interval, opening });
    view.onScroll(onScroll);
    if (latest !== undefined) view.draw(latest);
  }

  /** The refresh installed on the current client, removed with it. */
  let uninstallRefresh: (() => void) | undefined;
  let refreshed: unknown;
  const unsubscribe = connection.subscribe(() => {
    const state = connection.state;
    output("connection").value = describe(state);
    if (state.status !== "connected" || state.client === refreshed) return;
    refreshed = state.client;
    output("mode").value = state.client.mode;
    uninstallRefresh?.();
    uninstallRefresh = refreshOnAuthInvalid(state.client, {
      onRefreshed: () => bars.show(asked),
      onSessionLost: () => {
        sessionLost = true;
        output("auth").value = "signed out";
        signIn.hidden = false;
      },
    });
  });

  signIn.addEventListener("click", () => {
    const state = connection.state;
    if (state.status !== "connected") return;
    void signInAgain(state.client).then(() => {
      sessionLost = false;
      signIn.hidden = true;
      bars.show(asked);
    }, reportError);
  });

  const stopFeed = liveFeed({
    connection,
    config: market,
    url: feedUrl,
    onBatch(span) {
      // Pushed bars on screen, or just past its end as the market moves on.
      if (span.end < asked.start || span.start > asked.end + market.interval) {
        return;
      }
      asked = { start: asked.start, end: Math.max(asked.end, span.end) };
      bars.refresh(asked);
    },
  });

  const kind = chartKindOf(location.search);
  select.value = kind;
  select.addEventListener("change", () => {
    const next = chartKindOf(`?chart=${select.value}`);
    const url = new URL(location.href);
    url.searchParams.set("chart", next);
    history.replaceState(null, "", url);
    void mountChart(next);
  });
  void mountChart(kind);
  bars.show(asked);

  return async () => {
    disposed = true;
    onScroll.cancel();
    stopFeed();
    unsubscribe();
    uninstallRefresh?.();
    bars.dispose();
    view?.dispose();
    await connection.dispose();
  };
}
