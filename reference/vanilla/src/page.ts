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
  onTokensStored,
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
import {
  createClient,
  type GetResult,
  type Miss,
  type MissReason,
  type Range,
} from "tscache";
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
  showing <output data-testid="showing">–</output> UTC ·
  drawn <output data-testid="drawn">–</output> ·
  <output data-testid="missing">nothing missing</output>
  <button type="button" id="retry" hidden>Retry</button>
</p>
<p class="status">
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

const MISSING: Record<MissReason, string> = {
  uncached: "not loaded",
  "fetch-failed": "fetch failed",
  "auth-pending": "waiting for credentials",
};

/**
 * What the answer lacks. The bar forming now is left out: it stays
 * provisional, so a read from the cache alone reports it uncached though
 * it is drawn.
 */
function gapsOf({ timestamps, misses }: GetResult): Miss[] {
  const newest = timestamps.at(-1) ?? Number.POSITIVE_INFINITY;
  return misses.filter(
    ({ reason, range }) => reason !== "uncached" || range.start < newest,
  );
}

/**
 * The gaps by reason. After a failed fetch, a read from the cache alone
 * reports the same ranges as uncached; `failed` keeps naming the cause
 * until nothing is missing.
 */
function describeGaps(gaps: Miss[], failed: boolean): string {
  const counts = new Map<MissReason, number>();
  for (const { reason } of gaps) {
    const shown = failed && reason === "uncached" ? "fetch-failed" : reason;
    counts.set(shown, (counts.get(shown) ?? 0) + 1);
  }
  if (counts.size === 0) return "nothing missing";
  return [...counts]
    .map(([reason, n]) => `${MISSING[reason]}: ${n} range${n === 1 ? "" : "s"}`)
    .join(", ");
}

/** A UTC time as `MM-DD HH:MM`, the same in every locale. */
function utc(t: number): string {
  return new Date(t).toISOString().slice(5, 16).replace("T", " ");
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
  const retry = element<HTMLButtonElement>(root, "#retry");

  // Every write to the markup goes through these two, which do nothing
  // once the page is torn down: a callback still pending then (a read, a
  // refresh, a sign-in) must not touch a page started again in its place.
  function show(name: string, text: string): void {
    if (disposed) return;
    element<HTMLOutputElement>(root, `[data-testid="${name}"]`).value = text;
  }
  function reveal(button: HTMLButtonElement, visible: boolean): void {
    if (!disposed) button.hidden = !visible;
  }

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
  /** A fetch failed, and what it lacked is still missing. */
  let failed = false;

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
    show("auth", pending ? "refreshing credentials" : "signed in");
  }

  /**
   * Reads up to `end` with a fetch, which mends what the stream missed:
   * bars, or the final values of the bar forming when it broke. Only while
   * the chart follows the market; history is final, so a user reading it
   * misses nothing.
   */
  function catchUp(end: number): void {
    if (!following()) return;
    asked = { start: asked.start, end: Math.max(asked.end, end) };
    bars.show(asked);
  }

  /**
   * Whether the chart follows the market: what is on screen reaches the end
   * of what is read, which is now (a screen of history lies past its end
   * while the user reads history).
   */
  function following(): boolean {
    const visible = view?.visible();
    return visible !== undefined && visible.end + market.interval >= asked.end;
  }

  function showRange(): void {
    const visible = view?.visible();
    if (visible === undefined) return;
    show("showing", `${utc(visible.start)} – ${utc(visible.end)}`);
  }

  const bars = series(connection, {
    config: market,
    render({ result }) {
      latest = result;
      view?.draw(result);
      showRange();
      show("summary", summarize(result));
      show("drawn", new Date().toISOString().slice(11, 19));
      const gaps = gapsOf(result);
      if (gaps.length === 0) failed = false;
      if (gaps.some((gap) => gap.reason === "fetch-failed")) failed = true;
      show("missing", describeGaps(gaps, failed));
      reveal(retry, failed);
      showAuth(result);
    },
    fail(error) {
      show("connection", `read failed: ${String(error)}`);
    },
  });

  const onScroll = debounce(SCROLL_PAUSE_MS, (visible: Range) => {
    showRange();
    asked = readRange(visible, Date.now());
    bars.show(asked);
  });

  /** Shows the chart of `kind`, replacing the one shown. */
  async function mountChart(kind: ChartKind): Promise<void> {
    const mount = ++mounts;
    const create = await loadChart(kind);
    if (disposed || mount !== mounts) return;
    // The new chart opens where the old one was, history included.
    const shown = view?.visible() ?? opening;
    view?.dispose();
    chartElement.replaceChildren();
    view = create(chartElement, { interval: market.interval, opening: shown });
    view.onScroll(onScroll);
    if (latest !== undefined) view.draw(latest);
    showRange();
  }

  /** The listeners installed on the current client, removed with it. */
  let uninstall: (() => void) | undefined;
  let installed: unknown;
  const unsubscribe = connection.subscribe(() => {
    const state = connection.state;
    show("connection", describe(state));
    if (state.status !== "connected" || state.client === installed) return;
    const { client } = state;
    installed = client;
    show("mode", client.mode);
    uninstall?.();
    const stopRefresh = refreshOnAuthInvalid(client, {
      onRefreshed: () => bars.show(asked),
      onSessionLost: () => {
        sessionLost = true;
        show("auth", "signed out");
        reveal(signIn, true);
      },
    });
    // A new dataset version clears the cache (a pushed batch can carry
    // it); reads from the cache alone would never fetch the history back.
    const stopClear = client.on("cacheCleared", ({ cacheId }) => {
      if (cacheId === market.id) bars.show(asked);
    });
    uninstall = () => {
      stopRefresh();
      stopClear();
    };
  });

  /**
   * Removes the controls' listeners on teardown, so a page started again in
   * the same markup is the only one they reach.
   */
  const controls = new AbortController();
  const { signal } = controls;

  retry.addEventListener("click", () => bars.show(asked), { signal });

  function sessionRestored(): void {
    if (disposed) return;
    sessionLost = false;
    reveal(signIn, false);
    show("auth", "signed in");
    bars.show(asked);
  }

  signIn.addEventListener(
    "click",
    () => {
      const state = connection.state;
      if (state.status !== "connected") return;
      void signInAgain(state.client).then(sessionRestored, reportError);
    },
    { signal },
  );

  // Another tab signed in: adopt its token, as a tab on a worker of its
  // own must, and read again.
  const stopWatchingTokens = onTokensStored((context) => {
    const state = connection.state;
    if (!sessionLost || state.status !== "connected") return;
    void state.client.updateAuth(context).then(sessionRestored, reportError);
  });

  const stopFeed = liveFeed({
    connection,
    config: market,
    url: feedUrl,
    onBatch(span) {
      if (span.end < asked.start) return;
      // Pushed bars on screen, or just past its end as the market moves on:
      // they are in the cache, so read from it alone.
      if (span.start <= asked.end + market.interval) {
        asked = { start: asked.start, end: Math.max(asked.end, span.end) };
        bars.refresh(asked);
        return;
      }
      // Bars after a gap the stream did not fill.
      catchUp(span.end);
    },
    onOpened: () => catchUp(Date.now()),
  });

  const kind = chartKindOf(location.search);
  select.value = kind;
  select.addEventListener(
    "change",
    () => {
      const next = chartKindOf(`?chart=${select.value}`);
      const url = new URL(location.href);
      url.searchParams.set("chart", next);
      history.replaceState(null, "", url);
      void mountChart(next);
    },
    { signal },
  );
  void mountChart(kind);
  bars.show(asked);

  return async () => {
    disposed = true;
    controls.abort();
    onScroll.cancel();
    stopFeed();
    unsubscribe();
    uninstall?.();
    stopWatchingTokens();
    bars.dispose();
    view?.dispose();
    await connection.dispose();
  };
}
