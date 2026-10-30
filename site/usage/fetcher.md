# The fetcher module

Import from `tscache/fetcher` in your fetcher. The entry holds the fetcher's types and
`AuthInvalidError`, and imports nothing else, so a fetcher bundle stays small and pulls no page code into
the worker.

<<< @/snippets/fetcher.ts#fetcher{ts}

## Fetcher

The module's **default export**: an object with

- `fetch(request: FetchRequest): Promise<FetchResponse>`, required;
- `updateAuth?(context: unknown): void | Promise<void>`, optional: called by `client.updateAuth`
  before the new context takes effect, to swap credentials held in module state.

## FetchRequest

| Field | Holds |
|---|---|
| `cacheId` | the cache the fetch is for |
| `range` | the inclusive range to fetch, on the grid, already coalesced |
| `interval`, `alignmentOffset` | the cache's grid |
| `context` | a copy of the latest context from `createClient` or `updateAuth` |

## FetchResponse

The same shape as a `put` batch: `timestamps`, `fields`, and optional `meta: { version?, finalizedUntil? }`.
It is validated as a batch; a response that fails validation makes the range `'fetch-failed'`.

## AuthInvalidError

Throw it from `fetch` when the backend refuses the credentials. The worker recognises it by its `code`,
`'tscache:auth-invalid'` (exported as `AUTH_INVALID_CODE`), never by `instanceof`: the fetcher and the
worker are separate bundles and may each hold their own copy of the class. From the `tscache` entry,
`isAuthInvalidError(value)` makes the same check.

<<< @/snippets/errors.ts#marker{ts}

The full contract, what a response must contain, is in [Writing a fetcher](/guides/fetcher).
