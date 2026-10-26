// The live feed: new bars from the backend, put into the cache as they
// arrive, by one of three sources: Server-Sent Events, a WebSocket, or
// polling.
//
// One tab per browser holds the feed, elected with a Web Lock: when it
// closes, the lock passes to a waiting tab, which starts the source again.
// The holder brings each new bar into the cache, then tells the other tabs
// on a BroadcastChannel. With a SharedWorker every tab reads the one cache
// the holder filled, so the others only redraw; a tab with a cache of its
// own (a dedicated worker, or in-process) fills it itself. All tabs of a
// browser get the same hosting mode, so a holder and its readers agree on
// which case they are in.
//
// A pushing source (SSE, WebSocket) brings put batches. A put without a
// range only adds and overwrites points, and a pushed bar at or after the
// batch's finalizedUntil stays provisional: the cache stores it, but a read
// that fetches still asks the backend for it. A polling source needs no
// push endpoint: it reads the time since its last poll with a fetch, and
// the cache fetches only what it lacks there, which is the provisional
// end: the bar forming now, and the one that closed since.
//
// That is also how a page catches up after the feed breaks. Each time a
// source opens (a reconnect, or another tab taking the feed over), bars
// may have been missed: whole bars, or the final values of the bar that
// was forming, which a new stream does not send again. Every tab hears of
// the opening (onOpened) before the source's first bar, and a read that
// fetches over the provisional end mends both.

import type { Connection } from "@tscache/integrations/shared/connection";
import type { CacheConfig, PutBatch, Range } from "tscache";

/** What a source reports while its tab holds the feed. */
export interface Holder {
  /** The source opened, after an outage or under a new holder. */
  opened(): void;
  /** A pushed batch: put into the cache, and passed to the other tabs. */
  pushed(batch: PutBatch): void;
  /**
   * Reads `span` with a fetch, into the cache, and tells the other tabs.
   * Resolves whether every bar of it arrived (no failed or held-back
   * fetch), so the next poll can start where this one ended.
   */
  polled(span: Range): Promise<boolean>;
}

/**
 * A source of new bars, started when its tab takes the feed. Returns the
 * stop, called when the tab gives the feed up.
 */
export type Source = (holder: Holder) => () => void;

export interface LiveFeedOptions {
  connection: Connection;
  config: CacheConfig;
  /** What the holder runs. */
  source: Source;
  /** New bars are in the cache; `span` is the time they cover. */
  onBatch(span: Range): void;
  /**
   * A source opened, after an outage or under another tab: read the newest
   * bars with a fetch, since bars may have been missed.
   */
  onOpened(): void;
}

/** What the holder passes to the other tabs. */
type FeedMessage =
  | { kind: "opened" }
  | { kind: "batch"; batch: PutBatch }
  | { kind: "polled"; span: Range };

/** A pushed batch, checked at the edge: the cache rejects anything else. */
function parseBatch(data: string): PutBatch | undefined {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { timestamps, fields } = value as Record<string, unknown>;
  if (!Array.isArray(timestamps) || timestamps.length === 0) return undefined;
  if (typeof fields !== "object" || fields === null) return undefined;
  return value as PutBatch;
}

function spanOf({ timestamps }: PutBatch): Range {
  return {
    start: Number(timestamps[0]),
    end: Number(timestamps[timestamps.length - 1]),
  };
}

/**
 * Starts the feed for this tab: it waits for the lock, runs the source
 * while it has it, and applies what any tab holding the feed passes on,
 * whichever source that tab runs. Returns the teardown, which releases the
 * lock to the next tab.
 */
export function liveFeed({
  connection,
  config,
  source,
  onBatch,
  onOpened,
}: LiveFeedOptions): () => void {
  const name = `tscache-reference:feed:${config.id}`;
  const channel = new BroadcastChannel(name);
  const stop = new AbortController();
  /** Messages are applied one at a time, in the order they came. */
  let queue = Promise.resolve();

  function opened(): Promise<void> {
    queue = queue.then(() => {
      if (!stop.signal.aborted) onOpened();
    });
    return queue;
  }

  /**
   * Brings a message's bars into this tab's cache, unless the holder's
   * put or read already did (one SharedWorker cache), then redraws.
   * Resolves whether every bar arrived.
   */
  function apply(
    message: Exclude<FeedMessage, { kind: "opened" }>,
    held: boolean,
  ): Promise<boolean> {
    const applied = queue.then(async () => {
      const state = connection.state;
      if (state.status !== "connected") return false;
      let complete = true;
      if (held || state.client.mode !== "shared") {
        try {
          const cache = await connection.cache(state.client, config);
          if (message.kind === "batch") {
            await cache.put(message.batch);
          } else {
            const { misses } = await cache.get(message.span);
            complete = misses.every((miss) => miss.reason === "uncached");
          }
        } catch (error) {
          // A lost worker fails the put; the next client fetches instead.
          if (connection.state === state) reportError(error);
          return false;
        }
      }
      if (!stop.signal.aborted) {
        onBatch(
          message.kind === "batch" ? spanOf(message.batch) : message.span,
        );
      }
      return complete;
    });
    queue = applied.then(() => {});
    return applied;
  }

  function pass(message: FeedMessage): void {
    if (!stop.signal.aborted) channel.postMessage(message);
  }

  channel.onmessage = ({ data }: MessageEvent<FeedMessage>) => {
    void (data.kind === "opened" ? opened() : apply(data, false));
  };

  const holder: Holder = {
    opened() {
      void opened().then(() => pass({ kind: "opened" }));
    },
    pushed(batch) {
      const message: FeedMessage = { kind: "batch", batch };
      void apply(message, true).then(() => pass(message));
    },
    async polled(span) {
      const message: FeedMessage = { kind: "polled", span };
      const complete = await apply(message, true);
      pass(message);
      return complete;
    },
  };

  navigator.locks
    .request(
      name,
      { signal: stop.signal },
      () =>
        new Promise<void>((released) => {
          const stopSource = source(holder);
          stop.signal.addEventListener("abort", () => {
            stopSource();
            released();
          });
        }),
    )
    .catch((error: unknown) => {
      // Aborting while waiting for the lock rejects; that is the teardown.
      if (!stop.signal.aborted) reportError(error);
    });

  return () => {
    stop.abort();
    channel.close();
  };
}

/** Server-Sent Events from `url`, whose `bar` events carry put batches. */
export function eventSource(url: string): Source {
  return ({ opened, pushed }) => {
    const source = new EventSource(url);
    // Fires again on each reconnect, before its first batch.
    source.addEventListener("open", () => opened());
    source.addEventListener("bar", (event) => {
      const batch = parseBatch(event.data);
      if (batch !== undefined) pushed(batch);
    });
    return () => source.close();
  };
}

export interface SocketOptions {
  /** The socket's URL, absolute or relative to the page. */
  url: string;
  /** The first message, which subscribes with the access token. */
  subscribe(token: string): string;
  /** The close code of a refused token. */
  refusedCode: number;
  /** The access token to subscribe with. */
  token(): Promise<string>;
  /** The token that replaces `refused`; throws when the session is lost. */
  refresh(refused: string): Promise<string>;
  /**
   * The session could not be recovered. Calls `retry` once another tab
   * signs in; returns the stop of that wait.
   */
  lost(error: unknown, retry: () => void): () => void;
}

/** How soon a dropped socket reconnects, as the SSE stream's retry. */
const RECONNECT_MS = 500;

/**
 * A WebSocket that subscribes with the access token, whose messages are
 * put batches. Unlike an EventSource it does not reconnect by itself: it
 * reconnects after a drop, and after refreshing a refused token.
 */
export function webSocket({
  url,
  subscribe,
  refusedCode,
  token,
  refresh,
  lost,
}: SocketOptions): Source {
  return ({ opened, pushed }) => {
    let stopped = false;
    let socket: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopWaiting: (() => void) | undefined;

    function connect(access: string): void {
      if (stopped) return;
      const address = new URL(url, location.href);
      address.protocol = address.protocol === "https:" ? "wss:" : "ws:";
      const current = new WebSocket(address);
      socket = current;
      let first = true;
      current.addEventListener("open", () => current.send(subscribe(access)));
      current.addEventListener("message", ({ data }) => {
        // The backend answers a subscription with its first batch: the
        // socket is open for bars from then on.
        if (first) {
          first = false;
          opened();
        }
        const batch = parseBatch(String(data));
        if (batch !== undefined) pushed(batch);
      });
      current.addEventListener("close", ({ code }) => {
        if (stopped || socket !== current) return;
        if (code === refusedCode) void renew(access);
        else timer = setTimeout(() => void start(), RECONNECT_MS);
      });
    }

    async function start(): Promise<void> {
      try {
        connect(await token());
      } catch (error) {
        reportError(error);
      }
    }

    async function renew(refused: string): Promise<void> {
      let access: string;
      try {
        access = await refresh(refused);
      } catch (error) {
        if (stopped) return;
        stopWaiting = lost(error, () => {
          stopWaiting?.();
          void start();
        });
        return;
      }
      connect(access);
    }

    void start();
    return () => {
      stopped = true;
      clearTimeout(timer);
      stopWaiting?.();
      socket?.close();
    };
  };
}

/**
 * Polls every `everyMs`: reads the time since the last complete poll with
 * a fetch. Its first poll is the opening, when every tab that follows the
 * market reads its newest bars.
 */
export function polling(everyMs: number): Source {
  return ({ opened, polled }) => {
    opened();
    let since = Date.now();
    let polling = false;
    const timer = setInterval(() => {
      // A slow poll is not overtaken by the next.
      if (polling) return;
      polling = true;
      const span = { start: since, end: Date.now() };
      void polled(span)
        .then((complete) => {
          // Otherwise the next poll asks for this span again.
          if (complete) since = span.end;
        })
        .finally(() => {
          polling = false;
        });
    }, everyMs);
    return () => clearInterval(timer);
  };
}
