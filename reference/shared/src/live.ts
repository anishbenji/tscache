// The live feed: bars pushed by the backend over Server-Sent Events, put
// into the cache as they arrive.
//
// One tab per browser holds the stream, elected with a Web Lock: when it
// closes, the lock passes to a waiting tab, which opens the stream again.
// The holder puts each batch, then passes it to the other tabs on a
// BroadcastChannel. With a SharedWorker every tab reads the one cache the
// holder filled, so the others only redraw; a tab with a cache of its own
// (a dedicated worker, or in-process) puts the batch itself. All tabs of a
// browser get the same hosting mode, so a holder and its readers agree on
// which case they are in.
//
// A put without a range only adds and overwrites points, and a pushed bar
// at or after the batch's finalizedUntil stays provisional: the cache
// stores it, but a read that fetches still asks the backend for it.
//
// That is how a page catches up after the stream breaks. Each time the
// stream opens (a reconnect, or another tab taking it over), batches may
// have been missed: whole bars, or the final values of the bar that was
// forming, which a new stream does not send again. Every tab hears of the
// opening (onOpened) before the stream's first batch, and a read that
// fetches over the provisional end mends both.

import type { Connection } from "@tscache/integrations/shared/connection";
import type { CacheConfig, PutBatch, Range } from "tscache";

export interface LiveFeedOptions {
  connection: Connection;
  config: CacheConfig;
  /** The event stream's URL; each `bar` event carries a put batch as JSON. */
  url: string;
  /** A batch is in the cache; `span` is the time its bars cover. */
  onBatch(span: Range): void;
  /**
   * The stream opened, after an outage or under another tab: read the
   * newest bars with a fetch, since batches may have been missed.
   */
  onOpened(): void;
}

/** What the holder passes to the other tabs. */
type FeedMessage = { kind: "opened" } | { kind: "batch"; batch: PutBatch };

/** A pushed batch, checked at the edge: the cache rejects anything else. */
function parseBatch(data: string): PutBatch | undefined {
  const value: unknown = JSON.parse(data);
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
 * Starts the feed for this tab: it waits for the lock, holds the stream
 * while it has it, and applies every batch any tab holding it receives.
 * Returns the teardown, which releases the lock to the next tab.
 */
export function liveFeed({
  connection,
  config,
  url,
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

  function apply(batch: PutBatch, held: boolean): Promise<void> {
    queue = queue.then(async () => {
      const state = connection.state;
      if (state.status !== "connected") return;
      if (held || state.client.mode !== "shared") {
        try {
          const cache = await connection.cache(state.client, config);
          await cache.put(batch);
        } catch (error) {
          // A lost worker fails the put; the next client fetches instead.
          if (connection.state === state) reportError(error);
          return;
        }
      }
      if (!stop.signal.aborted) onBatch(spanOf(batch));
    });
    return queue;
  }

  function pass(message: FeedMessage): void {
    if (!stop.signal.aborted) channel.postMessage(message);
  }

  channel.onmessage = ({ data }: MessageEvent<FeedMessage>) => {
    void (data.kind === "opened" ? opened() : apply(data.batch, false));
  };

  navigator.locks
    .request(
      name,
      { signal: stop.signal },
      () =>
        new Promise<void>((released) => {
          const source = new EventSource(url);
          // Fires again on each reconnect, before its first batch.
          source.addEventListener("open", () => {
            void opened().then(() => pass({ kind: "opened" }));
          });
          source.addEventListener("bar", (event) => {
            const batch = parseBatch(event.data);
            if (batch === undefined) return;
            void apply(batch, true).then(() => pass({ kind: "batch", batch }));
          });
          stop.signal.addEventListener("abort", () => {
            source.close();
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
