// A server-rendered Svelte 5 page, the browser's half. It hydrates the app
// with the props the server rendered it from, so the hydration render
// writes what the server wrote, and seeds each client's cache with the
// server's read, so the live answer that follows fetches only what the read
// did not cover (the provisional last day, say).

import { type Component, hydrate, unmount } from "svelte";
import { type ClientOptions, createClient } from "tscache";
import { candles } from "../shared/candles";
import { connect } from "../shared/connection";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
  type ServerRead,
} from "../shared/hydration";
import { tscacheContext } from "./series.svelte";

/** Takes over the server's page (ssr-server.ts). Returns its teardown. */
export function hydratePage(
  App: Component<{ read: ServerRead }>,
  options: ClientOptions,
): () => Promise<void> {
  const target = document.getElementById("app");
  if (target === null) throw new Error("the page has no #app");
  const read = rehydrate(candles, readJson<Dehydrated>(SERVER_READ));
  const connection = connect(
    () => createClient(options),
    [{ config: candles, read }],
  );
  const app = hydrate(App, {
    target,
    props: { read },
    context: tscacheContext(connection),
  });
  return async () => {
    await unmount(app);
    await connection.dispose();
  };
}
