// A server-rendered page in Solid, the browser's half. It hydrates the
// server's markup from the server's read, then mounts the live chart, which
// connects with that read as every client's seed and shows it until its
// own answer lands, so the page never shows a fallback. The browser fetches
// only what the read did not cover (the provisional last day, say).

import { hydrate } from "@solidjs/web";
import { Errored, isPending, useContext } from "solid-js";
import { type ClientOptions, createClient } from "tscache";
import { candles, describe } from "../shared/candles";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
  type ServerRead,
} from "../shared/hydration";
import { Page, ServerChart } from "./page";
import { ConnectionContext, createConnection, createSeries } from "./series";

function Chart(props: { read: ServerRead }) {
  // The server's range: its covered parts come from the seed, so the first
  // answer costs at most the uncovered tail.
  const answer = createSeries(
    useContext(ConnectionContext),
    candles,
    () => props.read.range,
    { initial: props.read },
  );
  // A chart library would take answer().result.timestamps and .fields here.
  return (
    <p aria-busy={isPending(answer) ? "true" : undefined}>
      {describe(answer().result)}
    </p>
  );
}

function Live(props: { options: ClientOptions; read: ServerRead }) {
  const connection = createConnection(
    () => createClient(props.options),
    [{ config: candles, read: props.read }],
  );
  return (
    <ConnectionContext value={connection}>
      <Errored
        fallback={(error) => (
          <>
            <p role="alert">
              The chart could not update: {String(error())}. It shows what the
              server read.
            </p>
            <ServerChart result={props.read.result} />
          </>
        )}
      >
        <Chart read={props.read} />
      </Errored>
    </ConnectionContext>
  );
}

/** Takes over the server's page. Returns its teardown. */
export function hydratePage(options: ClientOptions): () => void {
  const root = document.getElementById("app");
  if (root === null) throw new Error("the page has no #app");
  const read = rehydrate(candles, readJson<Dehydrated>(SERVER_READ));
  return hydrate(
    () => (
      <Page read={read}>
        <Live options={options} read={read} />
      </Page>
    ),
    root,
  );
}
