# Server rendering

A server has no workers. It reads with an **in-process client** (`mode: 'in-process'`, no `workerUrl`),
which runs the engine and imports the fetcher module in the server's own process. The engine has no DOM
or worker code at module top level, so it loads in Node and Bun.

The page then carries the server's answer twice:

- **the columns**, so the browser's hydration render shows what the server rendered, before any client
  exists;
- **a snapshot**, which the browser applies to its own cache with `hydrate`, so its first live read
  fetches only what the server did not know, typically the provisional tail.

<figure class="demo-video">
  <video autoplay muted loop playsinline controls width="960" height="600" aria-describedby="demo-ssr" style="width: 100%; height: auto">
    <source src="/media/server-rendering.webm" type="video/webm" />
    <source src="/media/server-rendering.mp4" type="video/mp4" />
  </video>
  <figcaption id="demo-ssr">The reference client's server-rendered page (<code>/ssr</code>). The server has rendered the page before, so its in-process cache already holds the history; it renders the page from it, the browser's cache starts from the server's snapshot, and the chart draws the history at once. The backend serves only the newest bars, to the server's read and to the browser's. A server's first render after it starts fetches the history once. Recorded headless with Playwright from the demo hub's vanilla reference client; the counters above the page are its mock backend's.</figcaption>
</figure>

## The server

<<< @/snippets/snapshots-server.ts#server{ts}

::: danger Escape every `<` before the JSON goes into the page
`JSON.stringify` leaves `<` as it is, and the HTML parser ends a `<script>` element at the first
`</script>` it meets, inside a JSON string or not. A field name, a dataset `version`, or anything else in
the element (the columns beside the snapshot) that contains `</script>` would end the element early:
the rest of the JSON is parsed as HTML, the browser's `JSON.parse` of the element's text throws, and
when the string comes from data, the text after it runs as markup and script in your page (cross-site
scripting). Replacing every `<` with `\u003c`, as the snippet does, keeps the JSON valid and decoding to
the same value, and leaves the parser nothing to end the element with. tscache does not do it for you:
`encodeSnapshot` returns a JSON value, not HTML.
:::

- **One client per server process**, created at startup and shared by every render, so a render reads
  what earlier renders fetched. Every visitor then reads the same cache: use it for public data only.
- **The fetcher URL must be one the server can `import()`.** With Vite, `?fetcher` gives server code a
  file URL in a build and a path the module runner resolves in dev ([The Vite plugin](/guides/vite)).
- **A server has no page origin**, so a fetcher that requests relative paths needs the backend's origin
  from its context, as the server half above passes it. This site's fetcher and the examples' read
  `context.origin` and resolve each request URL against it; the browser's client omits it.
- The server's own credential, if the backend needs one, goes in the server client's context, never a
  visitor's.

## The browser

<<< @/snippets/snapshots-browser.ts#browser{ts}

<<< @/snippets/snapshots-page.ts#page{ts}

Apply the snapshot before the first live read. `hydrate` writes only where the browser's cache neither
covers anything nor holds a provisional point, in one call inside the worker, so another tab's newer
fetch is never replaced. A snapshot of another dataset version is refused (`skipped:
'version-mismatch'`), and a worker from before `hydrate` rejects it with "unknown op hydrate": treat both
as nothing applied, and the cache fetches. [Snapshots](/usage/snapshots) has the rules.

The snapshot stays usable after `hydrate`, so the client that replaces a lost one can be seeded from it
too; the integrations' `connect(open, seeds)` does that.

## Calendar caches

A cache with a [calendar interval](/concepts/grid#calendar-intervals) in a zone computes its slot
starts from the runtime's time-zone data, and the server and the browser each use their own. A
snapshot of such a cache therefore stores, beside each instant that names a slot (its range, its
coverage ranges, the start of each block of points), the slot the server gave it. `hydrate` refuses a
snapshot when the browser's data places one of those instants in another slot, with a `TscacheError`,
and changes nothing; treat that as "not seeded" and let the cache fetch.

- **Keep the server's zone data current** (Node's ICU data, which a Node upgrade brings). The usual
  cause of a difference is a rule change one side does not have yet.
- **What the check covers.** A snapshot that applies has every bar on the day, week or month the server
  put it on. It does not compare every bar's instant: when the two sides disagree only about dates
  strictly inside the snapshot, for example a daylight-saving rule one side lacks while both ends of
  the snapshot fall in the season where they agree, the snapshot applies, and the browser shows those
  bars at its own start of their slots, as it would after fetching them itself.
- **Very fragmented snapshots are refused.** The check's work is bounded before it starts: a snapshot
  with more than about 14,500 separate coverage ranges is refused. A snapshot of bars has one coverage
  range per uninterrupted stretch.

`encodeSnapshot` and `decodeSnapshot` carry a calendar cache's snapshot as they carry any other.

## How stale can a snapshot be?

As old as the page. With a versioned dataset, a stale snapshot is refused, or, in a cache created
without a version, adopted until the first response reporting a newer version clears it. Without a
version, a seed is no staler than the server's render was.

## Complete versions

- [`integrations/shared/server.ts`](https://github.com/anishbenji/tscache/blob/main/integrations/shared/server.ts) and
  [`hydration.ts`](https://github.com/anishbenji/tscache/blob/main/integrations/shared/hydration.ts): the server reader and the page encoding every
  framework snippet uses; [Vanilla JavaScript](/frameworks/vanilla), [React](/frameworks/react) and
  [Solid](/frameworks/solid) show each framework's halves.
- [`examples/react-ssr`](https://github.com/anishbenji/tscache/tree/main/examples/react-ssr) and [`examples/solid-ssr`](https://github.com/anishbenji/tscache/tree/main/examples/solid-ssr):
  runnable server-rendered apps.
- The reference clients' `/ssr` pages ([`reference/`](https://github.com/anishbenji/tscache/tree/main/reference)).
