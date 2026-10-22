// A server-rendered page without a framework, the browser's half. It keeps
// the server's markup until its own answer arrives, and fetches only what
// the server's answer did not cover (the provisional last day, say).

import { type ClientOptions, createClient } from "tscache";
import { candles, describe } from "../shared/candles";
import { connect } from "../shared/connection";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
} from "../shared/hydration";
import { series } from "./series";

/** Takes over the server's page. Returns its teardown. */
export function hydratePage(options: ClientOptions): () => Promise<void> {
  const element = document.getElementById("chart");
  if (element === null) throw new Error("the page has no #chart");
  const read = rehydrate(candles, readJson<Dehydrated>(SERVER_READ));
  const connection = connect(
    () => createClient(options),
    [{ config: candles, read }],
  );
  const chart = series(connection, {
    config: candles,
    render: ({ result }) => {
      element.textContent = describe(result);
    },
  });
  // The server's range: its covered parts come from the seed, so the
  // first answer costs at most the uncovered tail.
  chart.show(read.range);
  return async () => {
    chart.dispose();
    await connection.dispose();
  };
}
