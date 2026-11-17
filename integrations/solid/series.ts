// tscache in Solid 2: the app's connection in a context, and a series as an
// async memo over the connection's state and the range on screen. The memo
// is Solid's own latest-wins machinery: an answer for a range that a newer
// range has overtaken never lands, and while the next answer loads, the
// previous one stays on screen with isPending() true, so a chart never
// flashes a fallback. A change to the cache over the range on screen, from
// any tab, runs the memo again, at most once per frame (shared/changes.ts);
// a read from the cache alone then replaces the answer without pending.
// One connection (shared/connection.ts) serves every series of the app.

import type {
  CacheConfig,
  GetResult,
  Range,
  TscacheClient,
} from "@anishbenji/tscache";
import {
  type Accessor,
  createContext,
  createSignal,
  onCleanup,
} from "solid-js";
import { ViewReads } from "../shared/changes";
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
 * reads the range again. A change to the cache over `range()` reads it
 * again: from the cache alone, or with a fetch after a change that wrote
 * nothing (architecture §2.7). Only a read that may fetch is pending
 * (`isPending`): a read from the cache alone, after a live bar say, leaves
 * the answer on screen current until its own replaces it.
 */
export function createSeries(
  connection: Connection,
  config: CacheConfig,
  range: Accessor<Range>,
  { initial }: SeriesOptions = {},
): Accessor<Answer> {
  const [state, setState] = createSignal(connection.state);
  onCleanup(connection.subscribe(() => setState(connection.state)));
  const [changed, setChanged] = createSignal(0);
  // Holds a change during a fetching read, keeps failure labels, and
  // releases after the answer landed (shared/changes.ts).
  const views = new ViewReads({
    shown: range,
    interval: config.interval,
    alignmentOffset: config.alignmentOffset ?? 0,
    reread: () => setChanged((n) => n + 1),
  });
  /** Counts the memo's runs: only the latest run's cache-only answer lands. */
  let run = 0;
  /** A cache-only read's failure on a live client, for the next run to throw. */
  let failed: { error: unknown } | undefined;
  onCleanup(() => {
    run++;
    views.dispose();
  });

  // A memo that can also be written (a derived signal): a cache-only
  // answer is written over the last one, so it never makes the series
  // pending, and the next run that fetches replaces it.
  const [answer, setAnswer] = createSignal<Answer>(
    (previous: Answer | undefined) => {
      const current = state();
      const asked = range();
      changed();
      const mine = ++run;
      if (failed !== undefined) {
        const { error } = failed;
        failed = undefined;
        throw error;
      }
      if (current.status === "failed") throw current.error;
      // Pending until the client connects, which runs the memo again. A
      // fresh promise each time: one shared promise would keep the
      // callbacks of every run that ever waited on it.
      if (current.status === "connecting") return new Promise<never>(() => {});
      const read = views.read(
        connection.cache(current.client, config),
        asked,
        current,
      );
      const landing = read.answer.then((result) => ({ range: asked, result }));
      if (read.cacheOnly && previous !== undefined) {
        landing.then(
          (next) => {
            if (run === mine) setAnswer(() => next);
          },
          (error: unknown) => {
            // As below: only a failure on a live client counts.
            if (run !== mine || connection.state !== current) return;
            failed = { error };
            setChanged((n) => n + 1);
          },
        );
        return previous;
      }
      return landing.catch((error: unknown) => {
        // Only a failure on a live client counts. After a loss the memo
        // has run again on the new state, so this read stays pending
        // and Solid drops it as overtaken, whatever the order in which
        // the rejection and the state change arrive.
        if (connection.state === current) throw error;
        return new Promise<never>(() => {});
      });
    },
    initial === undefined ? undefined : { loadingValue: initial },
  );
  return answer;
}
