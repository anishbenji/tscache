// The page, the same component tree on the server and in the browser: the
// session's state as text, the two buttons it may offer, and the chart.
// The server renders the state the page starts in (initialState), from its
// own read; the browser's hydration render shows the same, so the markup
// matches, and then the session's state takes over.

import { type ChartKind, chartKindOf } from "@reference/shared/chart/load";
import { summarize } from "@reference/shared/market";
import {
  describeConnection,
  describeGaps,
  initialState,
  type Session,
  utc,
} from "@reference/shared/session";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { createMemo, createSignal, Show } from "solid-js";
import type { GetResult, Range } from "tscache";
import { Chart } from "./Chart";
import { createSessionState } from "./session";

export interface AppProps {
  /** The page's session; null on the server. */
  session: Session | null;
  /** The server's read, when the server rendered the page. */
  served?: ServerRead | undefined;
  /** The chart library the URL asked for (`?chart=`). */
  initialKind: ChartKind;
}

function time(t: number | undefined): string {
  return t === undefined ? "–" : new Date(t).toISOString().slice(11, 19);
}

function describeShowing(visible: Range | undefined): string {
  return visible === undefined
    ? "–"
    : `${utc(visible.start)} – ${utc(visible.end)}`;
}

function describeAnswer(answer: GetResult | undefined): string {
  return answer === undefined ? "loading…" : summarize(answer);
}

export function App(props: AppProps) {
  // The session and the server's read are the page's, fixed for its life.
  const { session } = props;
  const state = createSessionState(session, initialState(props.served));
  // Most changes leave the answer as it was (the connection, the auth
  // status); what reads it through this memo runs only for a new one.
  const answer = createMemo(() => state().answer);
  const [kind, setKind] = createSignal(props.initialKind);
  const [showing, setShowing] = createSignal<Range>();

  function chooseKind(value: string): void {
    const next = chartKindOf(`?chart=${value}`);
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
          <select
            id="chart-kind"
            onChange={(event) => chooseKind(event.currentTarget.value)}
          >
            {/* `selected`, which the server writes too, not the select's value. */}
            <option value="lightweight" selected={kind() === "lightweight"}>
              Lightweight Charts
            </option>
            <option value="uplot" selected={kind() === "uplot"}>
              uPlot
            </option>
          </select>
        </label>
      </header>
      <p class="status">
        <output data-testid="summary">{describeAnswer(answer())}</output> ·
        showing{" "}
        <output data-testid="showing">{describeShowing(showing())}</output> UTC
        · drawn <output data-testid="drawn">{time(state().answeredAt)}</output>{" "}
        · <output data-testid="missing">{describeGaps(state())}</output>{" "}
        <Show when={state().fetchFailed}>
          <button type="button" onClick={() => session?.retry()}>
            Retry
          </button>
        </Show>
      </p>
      <p class="status">
        mode <output data-testid="mode">{state().mode ?? "…"}</output> ·{" "}
        <output data-testid="connection">{describeConnection(state())}</output>{" "}
        · <output data-testid="auth">{state().auth}</output>{" "}
        <Show when={state().auth === "signed out"}>
          <button type="button" onClick={() => session?.signIn()}>
            Sign in again
          </button>
        </Show>
      </p>
      <Chart
        session={session}
        kind={kind()}
        answer={answer()}
        onShowing={(visible) => setShowing(visible)}
      />
    </>
  );
}
