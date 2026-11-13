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

The `BroadcastChannel` is the application's, because tscache sends no notification of its own; see
[Redrawing when the cache changes](#redrawing-when-the-cache-changes).

[`reference/shared/src/live.ts`](https://github.com/anishbenji/tscache/blob/main/reference/shared/src/live.ts) implements the election and the three
sources (`sse`, `ws`, `poll`); [`reference/README.md`](https://github.com/anishbenji/tscache/blob/main/reference/README.md) describes the
behaviour and its limits.

## Catching up after a gap

A pushed batch covers only its own span. If a feed drops for a while, the bars it missed stay
uncovered, and a fetching `get` over that stretch fills them. Note that a put without a range claims its own span, from
its first to its last timestamp: a batch that skips bars between those two confirms the skipped slots as
gaps. Push one bar, or one unbroken run of bars, per batch.

## Redrawing when the cache changes

::: warning Known limit: no change notifications
A reader gets no event when the data it read changes. A `put` from another tab, a fetch another tab's
`get` started, an `invalidate` and a moved watermark all change the cache silently. Apart from the opt-in `mergeWarning`, the
only event about a cache's contents is `cacheCleared`, when it is emptied ([Events](/concepts/events)). A subscription
event is sketched on the
[roadmap](https://github.com/anishbenji/tscache/blob/main/docs/roadmap.md#design-sketch-subscriptions-dirty-notifications).
:::

A view that must redraw reads again. After its own `put`, a tab knows what changed and calls `get` over
the range it shows. To learn of other tabs' changes, the application tells them, as the reference clients
do with a `BroadcastChannel`. Where the tabs share a SharedWorker, each then reads its shown range with
`get(range, { cacheOnly: true })`, which returns what the shared cache holds without fetching; with a
dedicated worker per tab, the other tab's cache is not this one, and the message has to carry the data. Without such a signal, a fetching `get` on a timer
([Polling](#polling)) also picks up what other tabs added. Listen for `cacheCleared` to redraw an
emptied cache.
