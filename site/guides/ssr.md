# Server rendering

A server has no workers. It reads with an **in-process client** (`mode: 'in-process'`, no `workerUrl`),
which runs the engine and imports the fetcher module in the server's own process. The engine has no DOM
or worker code at module top level, so it loads in Node and Bun.

The page then carries the server's answer twice:

- **the columns**, so the browser's hydration render shows what the server rendered, before any client
  exists;
- **a snapshot**, which the browser applies to its own cache with `hydrate`, so its first live read
  fetches only what the server did not know, typically the provisional tail.

## The server

<<< @/snippets/snapshots-server.ts#server{ts}

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
