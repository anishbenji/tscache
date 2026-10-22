// A page with one chart, client-only, in Svelte 5. The page owns the
// connection: it connects before it mounts the app, gives the app the
// connection as root context, and disposes it after unmounting the app.

import { type Component, mount, unmount } from "svelte";
import { type ClientOptions, createClient } from "tscache";
import { connect } from "../shared/connection";
import { tscacheContext } from "./series.svelte";

/**
 * Mounts `App` (README.md shows it) into `target`. `options` carries the
 * worker and fetcher URLs as your bundler serves them
 * (docs/guides/worker-setup.md). Returns the page's teardown; a page that
 * simply closes needs none, since a client disposes itself on `pagehide`.
 */
export function startPage(
  App: Component,
  options: ClientOptions,
  target: HTMLElement,
): () => Promise<void> {
  const connection = connect(() => createClient(options));
  const app = mount(App, { target, context: tscacheContext(connection) });
  return async () => {
    await unmount(app);
    await connection.dispose();
  };
}
