# Live feeds

A chart that follows the market needs the newest bars as they form. New data reaches the cache in one
of two ways, the watermark keeps the forming bar honest, and `cacheChanged` tells every listening tab
where the cache changed ([Change events](/concepts/events#change-events)).

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
per browser with a Web Lock to hold the feed: it puts each bar into the cache. With a SharedWorker every
tab, the holder included, hears the put as `cacheChanged` and reads the bar back from the same cache
with `cacheOnly`, without a fetch. With a dedicated worker or in-process, each tab has a cache of its
own and hears only its own changes, so the holder passes each bar on a `BroadcastChannel` and every tab
puts it into its own cache. When the holder closes, the lock passes to another tab. Each time a feed
opens again (the channel tells every tab), a tab that follows the market reads its newest bars with a
fetch, which mends what the feed missed while it was down.

[`reference/shared/src/live.ts`](https://github.com/anishbenji/tscache/blob/main/reference/shared/src/live.ts) implements the election and the three
sources (`sse`, `ws`, `poll`); [`reference/README.md`](https://github.com/anishbenji/tscache/blob/main/reference/README.md) describes the
behaviour and its limits.

## Catching up after a gap

A pushed batch covers only its own span. If a feed drops for a while, the bars it missed stay
uncovered, and a fetching `get` over that stretch fills them. Note that a put without a range claims its own span, from
its first to its last timestamp: a batch that skips bars between those two confirms the skipped slots as
gaps. Push one bar, or one unbroken run of bars, per batch.

<figure class="demo-video">
  <video autoplay muted loop playsinline controls width="960" height="600" aria-describedby="demo-reconnect" style="width: 100%; height: auto">
    <source src="/media/live-feed-reconnect.webm" type="video/webm" />
    <source src="/media/live-feed-reconnect.mp4" type="video/mp4" />
  </video>
  <figcaption id="demo-reconnect">The reference client following a live feed over Server-Sent Events, with one open stream. The backend drops every stream and moves its clock a minute on, as if the outage had lasted a minute. The open-stream count falls to zero and returns to one when the feed reconnects, and one fetch over the newest bars mends the bar the outage broke in, whose final values the new stream does not send again. Recorded headless with Playwright from the demo hub's vanilla reference client; the counters above the page are its mock backend's.</figcaption>
</figure>

## Redrawing when the cache changes

A view redraws on `cacheChanged`: a `put` from any tab, a fetch any tab's `get` started, a `hydrate`,
an `invalidate`, a watermark moved back and a clear each send one, to every tab that listens, the
writer's own included. Read the range on screen again by the [read
rule](/concepts/events#reading-after-an-event): with `cacheOnly` after an event that wrote something,
with a fetch after one that only withdrew coverage or cleared. The forming bar is written on every feed
tick, so a fetch on every event would loop; the rule never fetches because of a fetch. Coalesce a burst
of ticks into one read per animation frame, as the
[integrations](https://github.com/anishbenji/tscache/blob/main/integrations/shared/changes.ts) do.

::: warning Known limit: one cache per tab outside a SharedWorker
With a dedicated worker or in-process, each tab has a cache of its own, and `cacheChanged` reports only
that tab's changes. Another tab's `put` never reaches it: the application has to send the data, as the
reference clients do with a `BroadcastChannel`, or invalidate the range and fetch it again from an
updated backend. A fetching `get` on a timer ([Polling](#polling)) still brings each tab new and
provisional bars from the backend. A worker script from before change events sends none at all; check
`client.features.has('cacheChanged')` and poll where it is missing.
:::
