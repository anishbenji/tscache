// A server-rendered React page, the browser's half. Its hydration render
// shows the server's read, as the server's render did, so the markup
// matches; then the page switches to its own cache's answer in a background
// render, with no fallback in between. The cache starts from the server's
// read, so it fetches only what that did not cover (the provisional last
// day, say).

import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";
import { type ClientOptions, createClient } from "tscache";
import { candles } from "../shared/candles";
import { connect } from "../shared/connection";
import {
  type Dehydrated,
  readJson,
  rehydrate,
  SERVER_READ,
} from "../shared/hydration";
import { Page, ROOT } from "./page";
import { TscacheProvider } from "./series";

/** Takes over the server's page. Returns its teardown. */
export function hydratePage(options: ClientOptions): () => Promise<void> {
  const element = document.getElementById(ROOT);
  if (element === null) throw new Error(`the page has no #${ROOT}`);
  const read = rehydrate(candles, readJson<Dehydrated>(SERVER_READ));
  const seeds = [{ config: candles, read }];
  const connection = connect(() => createClient(options), seeds);
  const root = hydrateRoot(
    element,
    <StrictMode>
      <TscacheProvider connection={connection} seeds={seeds}>
        <Page range={read.range} />
      </TscacheProvider>
    </StrictMode>,
  );
  return async () => {
    root.unmount();
    await connection.dispose();
  };
}
