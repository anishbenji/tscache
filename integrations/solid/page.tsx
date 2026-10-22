// The server-rendered page, as both halves render it (ssr-server.tsx,
// ssr-browser.tsx). Until hydration ends, both render the server's read, so
// the browser's hydration render writes exactly the server's markup; then
// the live chart, which the browser's half passes as children, takes over.
// The live chart is created only after hydration, so nothing in it can make
// the hydrating render differ from the server's.

import type { JSX } from "@solidjs/web";
import { createSignal, onSettled, Show } from "solid-js";
import type { GetResult } from "tscache";
import { describe } from "../shared/candles";
import type { ServerRead } from "../shared/hydration";

/** The chart as the server read it. */
export function ServerChart(props: { result: GetResult }) {
  return <p>{describe(props.result)}</p>;
}

/** The server's read, then, once hydration has ended, `children`. */
export function Page(props: { read: ServerRead; children?: JSX.Element }) {
  const [hydrated, setHydrated] = createSignal(false);
  onSettled(() => {
    setHydrated(true);
  });
  return (
    <Show
      when={hydrated()}
      fallback={<ServerChart result={props.read.result} />}
    >
      {props.children}
    </Show>
  );
}
