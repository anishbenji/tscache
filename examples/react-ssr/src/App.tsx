// The page, rendered on the server and hydrated in the browser. Its first
// render shows what the server read (AppProps), in the server and in the
// browser's hydration render alike, so the two produce the same markup.
// After that the figures come from the browser's own cache, which starts
// from the server's seeds.

import type { Hydration } from "@examples/mock-backend/hydration";
import { useState, useSyncExternalStore } from "react";
import type { Range } from "tscache";
import { CandleChart } from "./Chart";
import { type Bar, HALF_YEAR, type Summary, utcDay } from "./candles";
import { useLog } from "./log";
import {
  type Connection,
  type Frame,
  useCandles,
  useConnection,
  useFetchCount,
} from "./session";

/** The id of the script element that carries the AppProps. */
export const APP_PROPS = "app-props";

/** What the server read, as the first render shows it. */
export interface AppProps {
  /** The window the server read: the last half-year at render time. */
  range: Range;
  summary: Summary;
  /** Bars of the window the server's cache held before this render. */
  serverCached: number;
}

/**
 * 'server-rendered' until the browser takes over; 'hydrating' until its
 * cache, started from the seeds, has answered; 'loading' while it answers
 * for a new window or a new client.
 */
type Status = "server-rendered" | "hydrating" | "loading" | "ready";

function statusOf(
  hydrated: boolean,
  frame: Frame | undefined,
  connection: Connection | undefined,
  start: number,
): Status {
  if (!hydrated) return "server-rendered";
  if (frame === undefined) return "hydrating";
  const current = frame.cache === connection?.cache && frame.start === start;
  return current ? "ready" : "loading";
}

const noSubscription = () => () => {};

/** False in the server's render and the browser's hydration render. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
}

// Fixed-format numbers and UTC days: the server and the browser must write
// every figure alike, whatever their locale and time zone. A value that is
// not finite shows as a dash: NaN is a legal field value, and the props'
// JSON brings it to the browser as null.
type Figure = number | null | undefined;
const finite = (value: Figure): value is number =>
  typeof value === "number" && Number.isFinite(value);
const price = (value: Figure) => (finite(value) ? value.toFixed(2) : "–");
const millions = (value: Figure) =>
  finite(value) ? `${(value / 1e6).toFixed(2)} M` : "–";
function percent(change: Figure): string {
  if (!finite(change)) return "–";
  return `${change >= 0 ? "+" : ""}${(change * 100).toFixed(2)} %`;
}

function Sessions({ bars }: { bars: Bar[] }) {
  return (
    <table className="sessions">
      <caption>The last five sessions</caption>
      <thead>
        <tr>
          <th scope="col">Day (UTC)</th>
          <th scope="col">Open</th>
          <th scope="col">High</th>
          <th scope="col">Low</th>
          <th scope="col">Close</th>
          <th scope="col">Volume</th>
        </tr>
      </thead>
      <tbody>
        {bars.map((bar) => (
          <tr key={bar.time}>
            <th scope="row">
              {utcDay(bar.time)}
              {bar.forming && " (forming)"}
            </th>
            <td>{price(bar.open)}</td>
            <td>{price(bar.high)}</td>
            <td>{price(bar.low)}</td>
            <td>{price(bar.close)}</td>
            <td>{millions(bar.volume)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Log() {
  const entries = useLog();
  return (
    <ol className="log" reversed>
      {entries.map((entry) => (
        <li key={entry.id}>{entry.text}</li>
      ))}
    </ol>
  );
}

export function App({
  range,
  summary,
  serverCached,
  hydration,
}: AppProps & { hydration: Hydration }) {
  // Subscribed before the connection's first get, so the count includes it.
  const fetches = useFetchCount();
  const connection = useConnection(hydration);
  const [start, setStart] = useState(range.start);
  const frame = useCandles(connection, start);
  const hydrated = useHydrated();

  const status = statusOf(hydrated, frame, connection, start);
  const shown = frame?.summary ?? summary;
  const shownStart = frame?.start ?? range.start;
  // From the start shown, not the one asked for: the scroll events that keep
  // coming while a half-year loads all ask for that same half-year.
  const earlier = () => setStart(shownStart - HALF_YEAR);

  return (
    <>
      <header>
        <h1>ACME · daily candles</h1>
        <p className="lede">Bars since {utcDay(shownStart)}, in UTC</p>
      </header>
      <p className="stats">
        <output data-testid="status">{status}</output> · mode{" "}
        <output data-testid="mode">{connection?.client.mode ?? "…"}</output> ·
        bars <output data-testid="bars">{shown.bars}</output> · last close{" "}
        <output data-testid="last-close">
          {price(shown.latest[0]?.close)}
        </output>{" "}
        · change <output data-testid="change">{percent(shown.change)}</output> ·
        days known empty{" "}
        <output data-testid="known-empty">{shown.knownEmpty}</output> · browser
        fetches <output data-testid="fetches">{fetches}</output>
      </p>
      <p className="stats">
        The server rendered the half-year with an in-process client:{" "}
        <output data-testid="server-cached">{serverCached}</output> of its{" "}
        {summary.bars} bars came from its cache.
      </p>
      <CandleChart result={frame?.result} onNearLeftEdge={earlier} />
      <p>
        Drag the chart to the right to scroll back; near the left edge the page
        asks for the half-year before.{" "}
        <button type="button" disabled={frame === undefined} onClick={earlier}>
          Load the half-year before
        </button>
      </p>
      <Sessions bars={shown.latest} />
      <h2>Log</h2>
      <Log />
    </>
  );
}
