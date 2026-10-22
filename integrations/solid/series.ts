// tscache in Solid 2: the app's connection in a context, and a series as an
// async memo over the connection's state and the range on screen. The memo
// is Solid's own latest-wins machinery: an answer for a range that a newer
// range has overtaken never lands, and while the next answer loads, the
// previous one stays on screen with isPending() true, so a chart never
// flashes a fallback. One connection (shared/connection.ts) serves every
// series of the app.

import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { CacheConfig, GetResult, Range, TscacheClient } from "tscache";
import { type Connection, connect, type Seed } from "../shared/connection";

/** The cache's answer for a range. */
export interface Answer {
  range: Range;
  result: GetResult;
}

/**
 * The app's connection, from {@link createConnection}. Provide it with
 * `<ConnectionContext value={connection}>`; a component reads it with
 * `useContext(ConnectionContext)`.
 */
export const ConnectionContext = createContext<Connection>();

/**
 * Connects for the calling owner's lifetime: call it once, in the app's
 * root component, and provide the connection with {@link ConnectionContext}.
 * Disposing the root (the function `render` or `hydrate` returns) disposes
 * the client; a page that simply closes needs no teardown, since a client
 * disposes itself on `pagehide`.
 */
export function createConnection(
  open: () => Promise<TscacheClient>,
  seeds?: readonly Seed[],
): Connection {
  const connection = connect(open, seeds);
  onCleanup(() => void connection.dispose());
  return connection;
}

export interface SeriesOptions {
  /**
   * The answer to show until the first read lands, such as the server's
   * read when hydrating. The series then never suspends to a `<Loading>`.
   */
  initial?: Answer;
}

/**
 * The cache's answer for `range()`, read through `connection` (in a
 * component, `useContext(ConnectionContext)`). Until the first answer it
 * suspends to the nearest `<Loading>` (unless `initial` is given); a read
 * that fails on a live client, and a connection that failed, throw to the
 * nearest `<Errored>`.
 *
 * A read that a lost worker rejected is not an error: the connection's
 * state moves on, the memo runs again, and the connection's next client
 * reads the range again.
 */
export function createSeries(
  connection: Connection,
  config: CacheConfig,
  range: Accessor<Range>,
  { initial }: SeriesOptions = {},
): Accessor<Answer> {
  const [state, setState] = createSignal(connection.state);
  onCleanup(connection.subscribe(() => setState(connection.state)));

  return createMemo<Answer>(
    () => {
      const current = state();
      const asked = range();
      if (current.status === "failed") throw current.error;
      // Pending until the client connects, which runs the memo again. A
      // fresh promise each time: one shared promise would keep the
      // callbacks of every run that ever waited on it.
      if (current.status === "connecting") return new Promise<never>(() => {});
      return connection
        .cache(current.client, config)
        .then((cache) => cache.get(asked))
        .then(
          (result) => ({ range: asked, result }),
          (error: unknown) => {
            // Only a failure on a live client counts. After a loss the memo
            // has run again on the new state, so this read stays pending
            // and Solid drops it as overtaken, whatever the order in which
            // the rejection and the state change arrive.
            if (connection.state === current) throw error;
            return new Promise<never>(() => {});
          },
        );
    },
    initial === undefined ? undefined : { loadingValue: initial },
  );
}
