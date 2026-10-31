// What a reference client's page does, whichever framework renders it: a
// live candle chart of the market, read through tscache.
//
// One connection serves the page (connect, from the integration snippets):
// it connects once, replaces the client when the worker behind it is lost,
// and starts each client's cache from the server's read when the page was
// rendered on the server. A series reads the range around what is on
// screen and keeps only the latest answer. Scrolling asks for the new
// range, and the cache fetches only what it does not hold. New bars come
// from the live feed (live.ts), over Server-Sent Events, a WebSocket or
// polling, as every tab of the origin chose (feed.ts); they go into the
// cache and are read back from it alone, so a push costs no fetch. Each
// time the feed opens, a page that follows the market reads its newest
// bars with a fetch, mending what the feed missed. An expired token is
// refreshed once across tabs (auth.ts), and the reads it held back are
// asked again.
//
// The session holds the page's state as one immutable object, replaced on
// each change, which a framework subscribes to: the vanilla page writes it
// into its markup, React reads it with useSyncExternalStore, Solid with a
// signal. Drawing the chart stays with the page; the session only asks the
// chart which time it shows (attachChart).

import {
  type Connection,
  type ConnectionState,
  connect,
} from "@tscache/integrations/shared/connection";
import type { ServerRead } from "@tscache/integrations/shared/hydration";
import { series } from "@tscache/integrations/vanilla/series";
import type {
  GetResult,
  HostingMode,
  Miss,
  MissReason,
  Range,
  TscacheClient,
} from "tscache";
import {
  accessToken,
  onTokensStored,
  refreshAccess,
  refreshOnAuthInvalid,
  signInAgain,
} from "./auth";
import type { ChartView } from "./chart/view";
import {
  DEFAULT_FEED,
  type FeedKind,
  onFeedStored,
  storedFeed,
  storeFeed,
} from "./feed";
import { eventSource, liveFeed, polling, type Source, webSocket } from "./live";
import {
  feedUrl,
  formingBar,
  market,
  openingRange,
  readRange,
  socketSubscription,
  socketUrl,
} from "./market";

/** How long scrolling must pause before the new range is read. */
const SCROLL_PAUSE_MS = 150;
/** How often the polling feed reads the newest bars. */
const POLL_MS = 2000;
/** The live socket's close code for a refused token (the mock backend's). */
const REFUSED = 4401;

export type AuthStatus = "signed in" | "refreshing credentials" | "signed out";

export interface SessionState {
  /** Where the connection stands; "live" once a client is connected. */
  readonly status: "connecting" | "live" | "failed";
  /** Why the connection failed, or why the latest read did. */
  readonly error: string | undefined;
  /** The hosting mode of the connected client. */
  readonly mode: HostingMode | undefined;
  /** The latest answer: the server's read until the client's first. */
  readonly answer: GetResult | undefined;
  /** When the client's latest answer arrived (ms); none for the server's. */
  readonly answeredAt: number | undefined;
  /** What the answer lacks (gapsOf). */
  readonly gaps: readonly Miss[];
  /** A fetch failed, and what it lacked is still missing: offer Retry. */
  readonly fetchFailed: boolean;
  readonly auth: AuthStatus;
  /** The live feed every tab of the origin takes. */
  readonly feed: FeedKind;
}

/**
 * What the answer lacks. The bar forming now is left out: it stays
 * provisional, so a read from the cache alone reports it uncached though
 * it is drawn.
 */
function gapsOf({ timestamps, misses }: GetResult): Miss[] {
  const newest = timestamps.at(-1) ?? Number.POSITIVE_INFINITY;
  return misses.filter(
    ({ reason, range }) => reason !== "uncached" || range.start < newest,
  );
}

/**
 * The state a page starts in, the same on the server and in the browser's
 * hydration render, so their markup matches: nothing about it depends on
 * the clock.
 */
export function initialState(
  served?: ServerRead,
  feed: FeedKind = DEFAULT_FEED,
): SessionState {
  return {
    status: "connecting",
    error: undefined,
    mode: undefined,
    answer: served?.result,
    answeredAt: undefined,
    gaps: served === undefined ? [] : gapsOf(served.result),
    fetchFailed: false,
    auth: "signed in",
    feed,
  };
}

const MISSING: Record<MissReason, string> = {
  uncached: "not loaded",
  "fetch-failed": "fetch failed",
  "auth-pending": "waiting for credentials",
};

/**
 * The gaps by reason. After a failed fetch, a read from the cache alone
 * reports the same ranges as uncached; `fetchFailed` keeps naming the
 * cause until nothing is missing.
 */
export function describeGaps({ gaps, fetchFailed }: SessionState): string {
  const counts = new Map<MissReason, number>();
  for (const { reason } of gaps) {
    const shown =
      fetchFailed && reason === "uncached" ? "fetch-failed" : reason;
    counts.set(shown, (counts.get(shown) ?? 0) + 1);
  }
  if (counts.size === 0) return "nothing missing";
  return [...counts]
    .map(([reason, n]) => `${MISSING[reason]}: ${n} range${n === 1 ? "" : "s"}`)
    .join(", ");
}

export function describeConnection({ status, error }: SessionState): string {
  if (error === undefined) return status;
  return status === "failed" ? `failed: ${error}` : `read failed: ${error}`;
}

/** A UTC time as `MM-DD HH:MM`, the same in every locale. */
export function utc(t: number): string {
  return new Date(t).toISOString().slice(5, 16).replace("T", " ");
}

export interface SessionOptions {
  /** Creates a client; runs again for each client replacing a lost one. */
  open(): Promise<TscacheClient>;
  /**
   * The server's read, when the server rendered the page: the cache starts
   * from it, and the state shows it until the client's first answer.
   */
  served?: ServerRead | undefined;
  /**
   * The feed the page's URL asks for (`?feed=`), which becomes every tab's;
   * without one, the feed chosen last, in any tab.
   */
  feed?: FeedKind | undefined;
}

export interface Session {
  /**
   * The time range a chart attached now opens on: the page's opening range
   * at first; after a chart was detached (another library replacing it),
   * where that chart was, moved on to the newest bars if it followed the
   * market.
   */
  readonly opening: Range;
  readonly state: SessionState;
  /**
   * Calls `listener` after each change of `state`. Returns the
   * unsubscribe. Needs no `this`, so pass it as it is.
   */
  subscribe(listener: () => void): () => void;
  /**
   * The chart on screen: the session asks it which time it shows, to
   * know whether the page follows the market. Returns the detach, after
   * which the session goes by what the chart showed last, until the next
   * chart is attached.
   */
  attachChart(chart: ChartView): () => void;
  /** The user scrolled the chart to `visible`; read it after a pause. */
  scrolled(visible: Range): void;
  /** Reads the range again with a fetch: the Retry after a failed one. */
  retry(): void;
  /** Signs in again after a lost session. */
  signIn(): void;
  /** Makes `feed` the live feed of every tab of the origin. */
  chooseFeed(feed: FeedKind): void;
  /** Tears the page's session down; nothing reaches its state after. */
  dispose(): Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function startSession({ open, served, feed }: SessionOptions): Session {
  const now = Date.now();
  const opening = openingRange(served?.range.end ?? now);
  /** The range the series reads: what is on screen, and a screen each side. */
  let asked = served?.range ?? readRange(opening, now);
  if (feed !== undefined) storeFeed(feed);
  let state = initialState(served, feed ?? storedFeed());
  let chart: ChartView | undefined;
  /**
   * The last chart, when it was detached and no chart has been attached
   * since (another library loading): what it showed, and whether it
   * followed the market, which the page then still does.
   */
  let detached: { visible: Range; following: boolean } | undefined;
  let disposed = false;
  const listeners = new Set<() => void>();

  /** The one way the state changes; nothing changes it after teardown. */
  function update(change: Partial<SessionState>): void {
    if (disposed) return;
    state = { ...state, ...change };
    for (const listener of listeners) listener();
  }

  const connection: Connection = connect(
    open,
    served === undefined ? [] : [{ config: market, read: served }],
  );

  const bars = series(connection, {
    config: market,
    render({ result }) {
      const gaps = gapsOf(result);
      const fetchFailed =
        gaps.some((gap) => gap.reason === "fetch-failed") ||
        (state.fetchFailed && gaps.length > 0);
      const pending = result.misses.some((m) => m.reason === "auth-pending");
      update({
        answer: result,
        answeredAt: Date.now(),
        gaps,
        fetchFailed,
        error: undefined,
        ...(state.auth !== "signed out" && {
          auth: pending ? "refreshing credentials" : "signed in",
        }),
      });
    },
    fail(error) {
      update({ error: describeError(error) });
    },
  });

  /**
   * Whether the chart follows the market: what is on screen reaches the end
   * of what is read, which is now (a screen of history lies past its end
   * while the user reads history).
   */
  function following(): boolean {
    if (chart === undefined) return detached?.following ?? false;
    const visible = chart.visible();
    return visible !== undefined && visible.end + market.interval >= asked.end;
  }

  /**
   * Reads up to `end` with a fetch, which mends what the stream missed:
   * bars, or the final values of the bar forming when it broke. Only while
   * the chart follows the market; history is final, so a user reading it
   * misses nothing.
   */
  function catchUp(end: number): void {
    if (!following()) return;
    asked = { start: asked.start, end: Math.max(asked.end, end) };
    bars.show(asked);
  }

  let scrollTimer: ReturnType<typeof setTimeout> | undefined;

  /** The listeners installed on the current client, removed with it. */
  let uninstall: (() => void) | undefined;
  let installed: TscacheClient | undefined;
  const unsubscribe = connection.subscribe(() => {
    const now: ConnectionState = connection.state;
    if (now.status === "failed") {
      update({ status: "failed", error: describeError(now.error) });
      return;
    }
    if (now.status === "connecting") {
      update({ status: "connecting", error: undefined });
      return;
    }
    update({ status: "live", error: undefined, mode: now.client.mode });
    if (now.client === installed) return;
    installed = now.client;
    uninstall?.();
    const stopRefresh = refreshOnAuthInvalid(now.client, {
      onRefreshed: () => bars.show(asked),
      onSessionLost: () => update({ auth: "signed out" }),
    });
    // A new dataset version clears the cache (a pushed batch can carry
    // it); reads from the cache alone would never fetch the history back.
    const stopClear = now.client.on("cacheCleared", ({ cacheId }) => {
      if (cacheId === market.id) bars.show(asked);
    });
    uninstall = () => {
      stopRefresh();
      stopClear();
    };
  });

  /** What waits for a sign-in in this tab: the live socket, after a lost session. */
  const signedIn = new Set<() => void>();

  function sessionRestored(): void {
    update({ auth: "signed in" });
    bars.show(asked);
    for (const resume of [...signedIn]) resume();
  }

  // Another tab signed in: adopt its token, as a tab on a worker of its
  // own must, and read again.
  const stopWatchingTokens = onTokensStored((context) => {
    const now = connection.state;
    if (state.auth !== "signed out" || now.status !== "connected") return;
    void now.client.updateAuth(context).then(sessionRestored, reportError);
  });

  /** The source of new bars, for the tab that holds the feed. */
  function sourceOf(kind: FeedKind): Source {
    switch (kind) {
      case "sse":
        return eventSource(feedUrl);
      case "ws":
        return webSocket({
          url: socketUrl,
          subscribe: (token) =>
            JSON.stringify({ ...socketSubscription, token }),
          refusedCode: REFUSED,
          token: accessToken,
          refresh: refreshAccess,
          lost(error, retry) {
            reportError(error);
            update({ auth: "signed out" });
            // A sign-in here stores the tokens without a storage event in
            // this tab, so the socket hears of it from sessionRestored.
            const resume = () => retry();
            signedIn.add(resume);
            const stopWatching = onTokensStored(resume);
            return () => {
              signedIn.delete(resume);
              stopWatching();
            };
          },
        });
      case "poll":
        return polling(POLL_MS, market);
    }
  }

  function startFeed(kind: FeedKind): () => void {
    return liveFeed({
      connection,
      config: market,
      source: sourceOf(kind),
      onBatch(span) {
        if (span.end < asked.start) return;
        // New bars on screen, or just past its end as the market moves on:
        // they are in the cache, so read from it alone.
        if (span.start <= asked.end + market.interval) {
          asked = { start: asked.start, end: Math.max(asked.end, span.end) };
          bars.refresh(asked);
          return;
        }
        // Bars after a gap the feed did not fill.
        catchUp(span.end);
      },
      // Up to the bar forming now, not now itself (formingBar).
      onOpened: () => catchUp(formingBar(Date.now())),
    });
  }

  let stopFeed = startFeed(state.feed);

  /** Takes `kind` as this tab's feed, which every tab now takes. */
  function adoptFeed(kind: FeedKind): void {
    if (disposed || kind === state.feed) return;
    stopFeed();
    update({ feed: kind });
    stopFeed = startFeed(kind);
  }
  const stopWatchingFeed = onFeedStored(adoptFeed);

  bars.show(asked);

  return {
    get opening() {
      if (detached === undefined) return opening;
      const { visible, following } = detached;
      if (!following) return visible;
      const shift = Math.max(0, asked.end - visible.end);
      return { start: visible.start + shift, end: visible.end + shift };
    },
    get state() {
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    attachChart(next) {
      chart = next;
      detached = undefined;
      return () => {
        if (chart !== next) return;
        const visible = next.visible();
        if (visible !== undefined)
          detached = { visible, following: following() };
        chart = undefined;
      };
    },
    scrolled(visible) {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        asked = readRange(visible, Date.now());
        bars.show(asked);
      }, SCROLL_PAUSE_MS);
    },
    retry: () => bars.show(asked),
    signIn() {
      const now = connection.state;
      if (now.status !== "connected") return;
      void signInAgain(now.client).then(sessionRestored, reportError);
    },
    chooseFeed(kind) {
      if (disposed) return;
      storeFeed(kind);
      adoptFeed(kind);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      clearTimeout(scrollTimer);
      stopFeed();
      stopWatchingFeed();
      unsubscribe();
      uninstall?.();
      stopWatchingTokens();
      bars.dispose();
      await connection.dispose();
    },
  };
}
