// A page with one chart, client-only. Connect once, give the chart a
// series, show the range on screen.

import { type ClientOptions, createClient } from "tscache";
import { candles, describe, lastDays } from "../shared/candles";
import { connect } from "../shared/connection";
import { series } from "./series";

/**
 * A page with one chart, showing the last 90 days. `options` carries the
 * worker and fetcher URLs as your bundler serves them
 * (docs/guides/worker-setup.md). Returns the page's teardown; a page that
 * simply closes needs none, since a client disposes itself on `pagehide`.
 */
export function startPage(
  options: ClientOptions,
  element: HTMLElement,
): () => Promise<void> {
  const connection = connect(() => createClient(options));
  const chart = series(connection, {
    config: candles,
    // A chart library would take result.timestamps and result.fields here.
    render: ({ result }) => {
      element.textContent = describe(result);
    },
  });
  chart.show(lastDays(90, Date.now()));
  // Scrolling the chart calls chart.show() with its visible range; the
  // cache fetches only what it does not hold.
  return async () => {
    chart.dispose();
    await connection.dispose();
  };
}
