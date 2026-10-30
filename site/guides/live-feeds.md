# Live feeds

A chart that follows the market needs the newest bars as they form. tscache has no subscriptions;
new data reaches the cache in one of two ways, and the watermark keeps the forming bar honest.

## The forming bar is provisional

Report `finalizedUntil` (the first timestamp that is not final) with every batch and response. The
forming bar is then stored and shown, but never covered, so the next fetching read over it asks the
backend again, and a bar that closed while the page was away is mended ([Versions and
watermarks](/concepts/freshness)).

## Pushing: Server-Sent Events or a WebSocket

A push feed brings bars; put each as a batch **without a range**. Such a put adds or overwrites the bars
it carries and removes nothing, and claims coverage only for its own span below the watermark.

<<< @/snippets/live.ts#push{ts}

A WebSocket works the same way. Unlike `EventSource`, it does not reconnect by itself, and it can
present a token in its first message, which an `EventSource` cannot send as a header.

## Polling

No push endpoint at all: read the newest stretch with a normal, fetching `get` on a timer. The cache
fetches only what it lacks there, which is the provisional end and any bar closed since.

<<< @/snippets/live.ts#poll{ts}

## Many tabs, one feed

Every tab with its own feed multiplies the backend's connections. The reference clients elect one tab
per browser with a Web Lock to hold the feed: it puts each bar into the cache and tells the other tabs
on a `BroadcastChannel`; with a SharedWorker they read the bar back from the same cache with
`cacheOnly`, without a fetch. When the holder closes, the lock passes to another tab. Each time a feed
opens again, a tab that follows the market reads its newest bars with a fetch, which mends what the feed
missed while it was down.

[`reference/shared/src/live.ts`](https://github.com/anishbenji/tscache/blob/main/reference/shared/src/live.ts) implements the election and the three
sources (`sse`, `ws`, `poll`); [`reference/README.md`](https://github.com/anishbenji/tscache/blob/main/reference/README.md) describes the
behaviour and its limits.

## Catching up after a gap

A pushed batch covers only its own span. If a feed drops for a while, the bars it missed stay
uncovered, and a fetching `get` over that stretch fills them. Note that a put without a range claims its own span, from
its first to its last timestamp: a batch that skips bars between those two confirms the skipped slots as
gaps. Push one bar, or one unbroken run of bars, per batch.
