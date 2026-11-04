# Getting started

## Install

```sh
npm install @anishbenji/tscache   # or: bun add @anishbenji/tscache, pnpm add @anishbenji/tscache
```

The package is ESM-only and has no runtime dependencies. Its entries:

| Import                        | For                                                                                    |
| ----------------------------- | -------------------------------------------------------------------------------------- |
| `@anishbenji/tscache`         | the page: `createClient`, the types, the errors, `encodeSnapshot` and `decodeSnapshot` |
| `@anishbenji/tscache/worker`  | the worker script; you serve it, you never import it into the page                     |
| `@anishbenji/tscache/fetcher` | your fetcher module: its types and `AuthInvalidError`, nothing else                    |
| `@anishbenji/tscache/engine`  | the engine without a worker, for Node and tests                                        |
| `@anishbenji/tscache/vite`    | `fetcherUrl()`, the Vite plugin for the fetcher module (`vite` 8 is an optional peer)  |

## 1. Serve the worker

`createClient` needs the URL of the `@anishbenji/tscache/worker` script as your bundler serves it. With Vite,
`?worker&url` gives it:

<<< @/snippets/getting-started.ts#client{ts}

webpack and setups without a bundler serve a copy of the package's `dist/` directory instead; see
[Workers and fallback](/guides/workers). If the URL is wrong, both worker hostings fail and the client
quietly falls back to an engine in the page, which no other tab shares: check `client.mode` once.

## 2. Write a fetcher

The fetcher is an ES module the worker loads with `import()`. Its default export has a `fetch` method
that returns every point of the requested range:

<<< @/snippets/fetcher.ts#fetcher{ts}

With Vite, add the plugin, which serves the module with its default export intact:

<<< @/snippets/vite-config.ts#config{ts}

For TypeScript, declare the `?fetcher` import once:

<<< @/snippets/env.d.ts{ts}

The fetcher is optional. Without one, the cache holds only what you `put`, and `get` reports the rest
as misses. [Writing a fetcher](/guides/fetcher) has the full contract.

## 3. Open a cache

<<< @/snippets/getting-started.ts#cache{ts}

`interval` is required: every timestamp of the cache lies on its grid. Every tab opens a cache with the
same config; a different structure under the same id is refused with `ConfigError`.

## 4. Read

<<< @/snippets/getting-started.ts#get{ts}

A range is inclusive at both ends, in milliseconds, and need not be on the grid: a read widens it to the
grid points around it, so a chart's visible range goes straight in. The read awaits the fetches for what
the cache lacks and resolves with every point it holds in the range, the parts it knows for certain
(`coverage`), and the parts it does not (`misses`, each with a reason). It never rejects because data
is unavailable: a failed fetch comes back as a miss.

## Next

- [Coverage and gaps](/concepts/coverage): what a result says.
- [Intervals and the grid](/concepts/grid): timestamps, alignment and ranges.
- [The client](/usage/client) and [A cache](/usage/cache): every method with an example.
- [Server rendering](/guides/ssr), [Live feeds](/guides/live-feeds), [React](/frameworks/react),
  [Solid](/frameworks/solid).
