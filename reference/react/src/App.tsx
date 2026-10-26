// The page, the same component tree on the server and in the browser: the
// session's state as text, the two buttons it may offer, and the chart.
// The server renders the state the page starts in (initialState), from its
// own read; the browser's hydration render shows the same, so the markup
// matches, and then the session's state takes over.

import { type ChartKind, chartKindOf } from "@reference/shared/chart/load";
import {
  FEED_OPTIONS,
  type FeedKind,
  feedKindOf,
  showFeedInUrl,
} from "@reference/shared/feed";
import { summarize } from "@reference/shared/market";
import {
  describeConnection,
  describeGaps,
  initialState,
  type Session,
  utc,
} from "@reference/shared/session";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { type ChangeEvent, useEffect, useState } from "react";
import type { Range } from "tscache";
import { Chart } from "./Chart";
import { useSessionState } from "./session";

export interface AppProps {
  /** The page's session; null on the server. */
  session: Session | null;
  /** The server's read, when the server rendered the page. */
  served?: ServerRead | undefined;
  /** The chart library the URL asked for (`?chart=`). */
  initialKind: ChartKind;
  /** The feed the URL asked for (`?feed=`), if any. */
  initialFeed?: FeedKind | undefined;
}

function time(t: number | undefined): string {
  return t === undefined ? "–" : new Date(t).toISOString().slice(11, 19);
}

export function App({ session, served, initialKind, initialFeed }: AppProps) {
  const [initial] = useState(() => initialState(served, initialFeed));
  const state = useSessionState(session, initial);
  const [kind, setKind] = useState(initialKind);
  const [showing, setShowing] = useState<Range>();

  useEffect(() => showFeedInUrl(state.feed), [state.feed]);

  function chooseFeed(event: ChangeEvent<HTMLSelectElement>): void {
    const chosen = feedKindOf(`?feed=${event.target.value}`);
    if (chosen !== undefined) session?.chooseFeed(chosen);
  }

  function chooseKind(event: ChangeEvent<HTMLSelectElement>): void {
    const next = chartKindOf(`?chart=${event.target.value}`);
    setKind(next);
    const url = new URL(location.href);
    url.searchParams.set("chart", next);
    history.replaceState(null, "", url);
  }

  return (
    <>
      <header>
        <h1>BTC · one-minute candles</h1>
        <label>
          Chart{" "}
          <select id="chart-kind" value={kind} onChange={chooseKind}>
            <option value="lightweight">Lightweight Charts</option>
            <option value="uplot">uPlot</option>
          </select>
        </label>
        <label>
          Feed{" "}
          <select id="feed-kind" value={state.feed} onChange={chooseFeed}>
            {FEED_OPTIONS.map(([feed, name]) => (
              <option key={feed} value={feed}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </header>
      <p className="status">
        <output data-testid="summary">
          {state.answer === undefined ? "loading…" : summarize(state.answer)}
        </output>{" "}
        · showing{" "}
        <output data-testid="showing">
          {showing === undefined
            ? "–"
            : `${utc(showing.start)} – ${utc(showing.end)}`}
        </output>{" "}
        UTC · drawn{" "}
        <output data-testid="drawn">{time(state.answeredAt)}</output> ·{" "}
        <output data-testid="missing">{describeGaps(state)}</output>{" "}
        {state.fetchFailed && (
          <button type="button" onClick={() => session?.retry()}>
            Retry
          </button>
        )}
      </p>
      <p className="status">
        mode <output data-testid="mode">{state.mode ?? "…"}</output> ·{" "}
        <output data-testid="connection">{describeConnection(state)}</output> ·{" "}
        <output data-testid="auth">{state.auth}</output>{" "}
        {state.auth === "signed out" && (
          <button type="button" onClick={() => session?.signIn()}>
            Sign in again
          </button>
        )}
      </p>
      <Chart
        session={session}
        kind={kind}
        answer={state.answer}
        onShowing={setShowing}
      />
    </>
  );
}
