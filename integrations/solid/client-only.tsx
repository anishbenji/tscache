// A page with one chart, client-only. The app's root component connects
// once and provides the connection; the chart reads its range through it.
// Disposing the app disposes the client.

import { render } from "@solidjs/web";
import { Errored, isPending, Loading, useContext } from "solid-js";
import { type ClientOptions, createClient } from "tscache";
import { candles, describe, lastDays } from "../shared/candles";
import { ConnectionContext, createConnection, createSeries } from "./series";

function Chart() {
  // A chart passes its visible range as a signal, so scrolling reads the
  // new range; the cache fetches only what it does not hold.
  const range = lastDays(90, Date.now());
  const answer = createSeries(
    useContext(ConnectionContext),
    candles,
    () => range,
  );
  // A chart library would take answer().result.timestamps and .fields here.
  return (
    <p aria-busy={isPending(answer) ? "true" : undefined}>
      {describe(answer().result)}
    </p>
  );
}

function App(props: { options: ClientOptions }) {
  const connection = createConnection(() => createClient(props.options));
  return (
    <ConnectionContext value={connection}>
      <Errored
        fallback={(error) => (
          <p role="alert">The chart could not load: {String(error())}</p>
        )}
      >
        <Loading fallback={<p>Loading the last 90 days…</p>}>
          <Chart />
        </Loading>
      </Errored>
    </ConnectionContext>
  );
}

/**
 * A page with one chart, showing the last 90 days. `options` carries the
 * worker and fetcher URLs as your bundler serves them
 * (docs/guides/worker-setup.md). Returns the page's teardown.
 */
export function startPage(
  options: ClientOptions,
  element: HTMLElement,
): () => void {
  return render(() => <App options={options} />, element);
}
