# Writing a fetcher

The fetcher is the one piece of your code that runs inside tscache's worker. The worker loads it once,
with `import()`, and calls its default export's `fetch` for every range a `get` needs.

<<< @/snippets/fetcher.ts#fetcher{ts}

## The module

- **An ES module, served from your origin, with its default export intact.** With Vite, use
  [`?fetcher`](/guides/vite); `?worker&url` drops the exports. The worker resolves a relative URL
  against its own script, not the page, so pass an absolute URL or path.
- **Self-contained.** It closes over nothing on the page. What it needs (a token, an API origin) arrives
  as `context`, a structured-cloneable value from `createClient` or `updateAuth`; each fetch gets a copy
  of the latest.
- **Imports from `tscache/fetcher`**, which holds the types and `AuthInvalidError` and nothing else.
- **Loaded at startup.** A module that fails to import, or whose default export has no `fetch`, makes
  `createClient` reject with a `TscacheError` naming it, so a broken fetcher does not look like a flaky
  backend.
- **Never closes its worker** (`self.close()`): a dedicated worker that does fires no `error`, and the
  calls of its tab hang.
- **Bounds each request**, for example with `AbortSignal.timeout()` on its `fetch`, and throws when the
  bound passes. The worker never cancels a fetch, and one fetch serves every `get` that needs one of its
  slots, from every tab, so a request that never settles holds them all. The thrown error is an ordinary
  failure: a `'fetch-failed'` miss, and the next `get` tries again.

## What a response must contain

A response is **authoritative for the whole requested range**. Every point the backend has in
`[range.start, range.end]` must be in it; slots without a point become confirmed gaps, and points the
cache held there that the response lacks are removed. So:

- **Paginated APIs:** loop until you have every page before returning. A partial response records the
  missing points as gaps that are never fetched again.
- **Late or revised data:** report `meta.finalizedUntil`, the first timestamp that is not final yet.
  Points at or after it are stored but stay provisional and are fetched again; the response is
  authoritative only below it. Across pages, report the earliest page's watermark.
- **Versioned datasets:** report `meta.version`. A change clears every tab's cache and applies this
  response. Do not assemble one response from two versions.
- **Timestamps** on the cache's grid (`request.interval`, `request.alignmentOffset`), ascending,
  unique, with every field present. A response that fails validation makes the range `'fetch-failed'`.

The range is already coalesced: adjacent misses are merged, and a miss next to known data is extended by
one interval into it.

## Errors

| You throw | The `get` sees | Then |
|---|---|---|
| `AuthInvalidError` | the range as `'auth-pending'` | every tab hears `authInvalid`; no fetch runs until `updateAuth` ([Credentials](/guides/auth)) |
| anything else | the range as `'fetch-failed'`, with the error's `name` and `message` | nothing is cached; the next `get` tries again |

Retries, backoff and timeouts are yours: tscache retries nothing on behalf of a `get` that already
returned.

## Deduplication

One fetch serves every tab: a second `get`, from any tab, that needs the same coalesced range of the
same cache awaits the fetch in flight. Overlapping but different ranges are fetched separately.

## A real one

The examples' fetcher, [`examples/mock-backend/src/fetcher.ts`](https://github.com/anishbenji/tscache/blob/main/examples/mock-backend/src/fetcher.ts),
pages through the mock backend, retries a fetch whose pages straddle a version change, and reads its
backend origin from `context` on the server:

<<< ../../examples/mock-backend/src/fetcher.ts{ts}

Without a bundler, write the fetcher as a plain ES module and import `AuthInvalidError` from your served
copy of `dist/fetcher.js`.
