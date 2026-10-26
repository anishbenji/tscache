// The page without a framework: the session (session.ts) does what the
// page does, and this file writes its state into the markup and draws the
// chart. Two charts can show it, Lightweight Charts and uPlot; the page
// switches between them and loads only the one it shows.

import fetcherModule from "@examples/mock-backend/fetcher?fetcher";
import { fetcherContext } from "@reference/shared/auth";
import {
  type ChartKind,
  chartKindOf,
  loadChart,
} from "@reference/shared/chart/load";
import type { ChartView } from "@reference/shared/chart/view";
import { market, summarize } from "@reference/shared/market";
import {
  describeConnection,
  describeGaps,
  type SessionState,
  startSession,
  utc,
} from "@reference/shared/session";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { createClient } from "tscache";
import workerUrl from "tscache/worker?worker&url";

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
  const output = (name: string) =>
    element<HTMLOutputElement>(root, `[data-testid="${name}"]`);

  const session = startSession({
    open: async () =>
      createClient({
        workerUrl,
        fetcher: { module: fetcherModule, context: await fetcherContext() },
      }),
    served,
  });
  let view: ChartView | undefined;
  let detach: (() => void) | undefined;
  let mounts = 0;
  let disposed = false;

  function showRange(): void {
    const visible = view?.visible();
    if (visible === undefined) return;
    output("showing").value = `${utc(visible.start)} – ${utc(visible.end)}`;
  }

  /** The state last written, so each write touches only what changed. */
  let shown: SessionState | undefined;
  function render(state: SessionState): void {
    if (state.answer !== undefined && state.answer !== shown?.answer) {
      view?.draw(state.answer);
      showRange();
      output("summary").value = summarize(state.answer);
    }
    if (state.answeredAt !== undefined) {
      output("drawn").value = new Date(state.answeredAt)
        .toISOString()
        .slice(11, 19);
    }
    output("missing").value = describeGaps(state);
    retry.hidden = !state.fetchFailed;
    output("mode").value = state.mode ?? "…";
    output("connection").value = describeConnection(state);
    output("auth").value = state.auth;
    signIn.hidden = state.auth !== "signed out";
    shown = state;
  }
  // The session changes nothing after teardown, so neither does this.
  const unsubscribe = session.subscribe(() => render(session.state));

  /** Shows the chart of `kind`, replacing the one shown. */
  async function mountChart(kind: ChartKind): Promise<void> {
    const mount = ++mounts;
    const create = await loadChart(kind);
    if (disposed || mount !== mounts) return;
    // The new chart opens where the old one was, history included.
    const opening = view?.visible() ?? session.opening;
    detach?.();
    view?.dispose();
    chartElement.replaceChildren();
    view = create(chartElement, { interval: market.interval, opening });
    detach = session.attachChart(view);
    view.onScroll((visible) => {
      showRange();
      session.scrolled(visible);
    });
    const { answer } = session.state;
    if (answer !== undefined) view.draw(answer);
    showRange();
  }

  /**
   * Removes the controls' listeners on teardown, so a page started again in
   * the same markup is the only one they reach.
   */
  const controls = new AbortController();
  const { signal } = controls;
  retry.addEventListener("click", () => session.retry(), { signal });
  signIn.addEventListener("click", () => session.signIn(), { signal });

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
  render(session.state);

  return async () => {
    disposed = true;
    controls.abort();
    unsubscribe();
    detach?.();
    view?.dispose();
    await session.dispose();
  };
}
