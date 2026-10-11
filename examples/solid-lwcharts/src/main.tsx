// OHLCV scroll-back with weekend gaps. Bars exist only in weekday trading
// sessions; tscache records coverage (what is known) apart from data (what
// exists), so the nights and weekends of a fetched range are confirmed
// empty. Scrolling back re-asks the cache for the whole loaded range, and
// only what it does not cover is fetched: the older fortnight, and the
// provisional slot at the right edge.

import { datasets } from "@examples/mock-backend/datasets";
import { render } from "@solidjs/web";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  isPending,
  Loading,
  onSettled,
} from "solid-js";
import type { CacheConfig, GetResult } from "tscache";
import { type CandleChart, createCandleChart } from "./chart";
import { createTscacheClient, fetches, lines, log } from "./session";
import "./style.css";

const INTERVAL = 30 * 60_000;
const FORTNIGHT = 14 * 24 * 3_600_000;

const config: CacheConfig = {
  id: "candles/ACME/30m",
  interval: INTERVAL,
  fields: datasets.candles.fields,
};

/** Covered slots without a bar: the nights and weekends known to be empty. */
function knownEmpty({ coverage, timestamps }: GetResult): number {
  let empty = 0;
  for (const { start, end } of coverage) {
    const bars = timestamps.filter((t) => t >= start && t <= end).length;
    empty += (end - start) / INTERVAL + 1 - bars;
  }
  return empty;
}

function logMisses({ misses }: GetResult): void {
  for (const miss of misses) {
    if (miss.reason !== "uncached") log(`miss: ${miss.reason}`);
  }
}

function Chart(props: { result: GetResult; onNearLeftEdge: () => void }) {
  let chart: CandleChart | undefined;
  createEffect(
    () => props.result,
    (result) => {
      chart?.draw(result);
      logMisses(result);
    },
  );
  onSettled(() => () => chart?.remove());
  return (
    <div
      class="chart"
      ref={(element) => {
        chart = createCandleChart(element, () => props.onNearLeftEdge());
      }}
    />
  );
}

const time = (t: number) => new Date(t).toLocaleTimeString();

function App() {
  const client = createTscacheClient();
  const cache = createMemo(() => client().cache(config));
  const [start, setStart] = createSignal(Date.now() - FORTNIGHT);
  const loaded = createMemo(() =>
    cache().get({ start: start(), end: Date.now() }),
  );
  // start() keeps its committed value until the answer for a new start has
  // landed, so the scroll events that keep coming while a fortnight loads
  // all ask for that same fortnight.
  const earlier = () => setStart(start() - FORTNIGHT);

  return (
    <>
      <header>
        <h1>Candles with weekend gaps</h1>
        <span>ACME, 30-minute bars, times in UTC</span>
      </header>
      <p class="stats">
        Mode{" "}
        <output data-testid="mode">
          <Loading fallback="…">{client().mode}</Loading>
        </output>{" "}
        · backend fetches <output data-testid="fetches">{fetches()}</output> ·
        bars{" "}
        <output data-testid="bars">
          <Loading fallback="0">{loaded().timestamps.length}</Loading>
        </output>{" "}
        · empty slots known{" "}
        <output data-testid="empty">
          <Loading fallback="0">{knownEmpty(loaded())}</Loading>
        </output>{" "}
        ·{" "}
        <output data-testid="status">
          <Loading fallback="connecting">
            {isPending(() => loaded()) ? "loading" : "ready"}
          </Loading>
        </output>
      </p>
      <Loading fallback={<div class="chart" />}>
        <Chart result={loaded()} onNearLeftEdge={earlier} />
      </Loading>
      <p>
        Drag the chart to the right to scroll back; near the left edge the page
        asks for the fortnight before.{" "}
        <button type="button" onClick={earlier}>
          Load an earlier fortnight
        </button>
      </p>
      <h2>Log</h2>
      <ol class="log" reversed>
        <For each={lines()}>
          {(line) => <li>{`${time(line.at)}  ${line.text}`}</li>}
        </For>
      </ol>
    </>
  );
}

render(() => <App />, document.querySelector("#app") ?? document.body);
