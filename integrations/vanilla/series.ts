// tscache without a framework: a series shows the cache's answer for the
// range on screen, and drops answers that a newer range has overtaken. It
// follows the cache's changes, from any tab (shared/changes.ts): an event
// over the range on screen reads it again, at most once per frame. One
// connection (shared/connection.ts) serves every series of the page.

import type { CacheConfig, GetResult, Range } from "@anishbenji/tscache";
import { type Frame, type ReadMode, ViewReads } from "../shared/changes";
import type { Connection } from "../shared/connection";

/** The cache's answer for a range. */
export interface Answer {
  range: Range;
  result: GetResult;
}

export interface SeriesOptions {
  config: CacheConfig;
  /** Draws an answer. Only the answer for the latest range arrives here. */
  render(answer: Answer): void;
  /** A read failed, or the client could not connect. Default: reportError. */
  fail?(error: unknown): void;
  /** For tests: the frame scheduler of the change watch. */
  frame?: Frame;
}

export interface Series {
  /** Reads `range` and renders the answer, unless a later show() overtakes it. */
  show(range: Range): void;
  /**
   * Reads `range` (by default the range on screen) from the cache alone,
   * without fetching: after a put of pushed data, say. It becomes the range
   * on screen. Skipped while a show()'s read is still in flight, whose
   * answer replaces this one anyway.
   */
  refresh(range?: Range): void;
  /**
   * Stops rendering and following changes; an answer still in flight is
   * dropped, and later show() and refresh() calls (from a callback still
   * pending) do nothing.
   */
  dispose(): void;
}

export function series(
  connection: Connection,
  { config, render, fail = reportError, frame }: SeriesOptions,
): Series {
  let range: Range | undefined;
  let latest = 0;
  /** The request number of the show() read in flight, or 0. */
  let showing = 0;
  let disposed = false;
  // Holds a change during a fetching read, keeps failure labels, and
  // releases after the answer landed (shared/changes.ts).
  const views = new ViewReads({
    shown: () => range,
    interval: config.interval,
    reread: () => read("auto"),
    ...(frame === undefined ? {} : { frame }),
  });

  function read(mode: ReadMode): void {
    if (disposed) return;
    const state = connection.state;
    if (state.status === "failed") {
      fail(state.error);
      return;
    }
    if (state.status !== "connected" || range === undefined) return;
    const request = ++latest;
    const asked = range;
    const reading = views.read(
      connection.cache(state.client, config),
      asked,
      [state, asked],
      mode,
    );
    if (!reading.cacheOnly) showing = request;
    reading.answer
      .then(
        (result) => {
          if (request === latest) render({ range: asked, result });
        },
        (error: unknown) => {
          // A lost worker rejects what was pending; the connection's next
          // client reads again, so only a failure on a live client counts.
          if (request === latest && connection.state === state) fail(error);
        },
      )
      .finally(() => {
        if (showing === request) showing = 0;
      });
  }

  function refresh(next = range): void {
    if (showing !== 0 || next === undefined) return;
    range = next;
    read("cache");
  }

  // A new client (the first, or one replacing a lost worker) reads again.
  const unsubscribe = connection.subscribe(() => read("fetch"));
  return {
    show(next) {
      range = next;
      read("fetch");
    },
    refresh,
    dispose() {
      disposed = true;
      unsubscribe();
      views.dispose();
      latest++;
    },
  };
}
