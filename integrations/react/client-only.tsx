// A page with one chart, client-only, in React. The connection is created
// before the first render and disposed after the root unmounts, so it lives
// as long as the page, whatever React mounts twice in StrictMode.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { type ClientOptions, createClient } from "tscache";
import { lastDays } from "../shared/candles";
import { connect } from "../shared/connection";
import { Page } from "./page";
import { TscacheProvider } from "./series";

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
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <TscacheProvider connection={connection}>
        <Page range={lastDays(90, Date.now())} />
      </TscacheProvider>
    </StrictMode>,
  );
  return async () => {
    root.unmount();
    await connection.dispose();
  };
}
