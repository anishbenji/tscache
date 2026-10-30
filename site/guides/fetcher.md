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

## Binary pages

JSON is the easy format, and for small pages it is fast enough. For a chart's pages it is often the
largest cost in a fetch after the network: every number is parsed from text, and every column is then
copied into a typed array. A binary page of typed columns needs neither. Measured in Chromium 153 on an
Apple Silicon Mac, for one 5,000-bar OHLCV page:

| Decoding | Body | Time |
|---|---:|---:|
| Row JSON (`[{ t, o, h, l, c, v }]`), `JSON.parse` | 382 KB | 533 µs |
| Columnar JSON through `Response.json()`, then `Float64Array.from` per column | 252 KB | 443 µs |
| The same with `JSON.parse` on text already read | 252 KB | 321 µs |
| Binary columns through `Response.arrayBuffer()`, viewed in place | 220 KB | 93 µs |
| Binary columns already in memory: views only / copied into new arrays | 220 KB | 0.13 µs / 10.4 µs |

The decode runs in the worker, so it delays every fetch's data, in every tab the worker serves. The
fetcher contract already accepts typed arrays (`FetchResponse` takes `Float64Array` timestamps and any
numeric typed array per field), so binary pages need nothing from tscache: only a format your backend
and your fetcher agree on.

### The format

The examples define one, in [`examples/mock-backend/src/columns.ts`](https://github.com/anishbenji/tscache/blob/main/examples/mock-backend/src/columns.ts):
a short JSON header, then the timestamps and one column per field, each in its field's dtype. Every
number is little-endian, the byte order of every platform a browser runs on.

| Bytes | Holds |
|---|---|
| 4 | the magic `TSC` and the format version, 1 (`54 53 43 01`) |
| 4 | `H`, the header's length, as a u32 |
| `H` | the header, UTF-8 JSON: a `ColumnsHeader` |
| to a multiple of 8 | zero padding |
| `count` × 8 | the timestamps, as f64 |
| per field, in the header's order | zero padding to a multiple of 8, then `count` values of the field's dtype |

<<< ../../examples/mock-backend/src/columns.ts#format{ts}

**Why the padding.** A typed array can only view bytes at an offset that is a multiple of its element
size: `new Float64Array(buffer, 12, n)` throws. Starting every column on an 8-byte boundary lets each one
be viewed where it lies in the body. A `count` of 0 is a valid, empty page.

**Why a JSON header.** It is a few hundred bytes, parsed once per page, and it carries what the JSON form
carries besides the columns (here the page's `meta` and its `next` cursor) without a second format.

**Integer fields cannot hold `NaN`.** A float column carries `NaN` as is; the encoder refuses a value an
integer dtype cannot hold rather than store it as 0.

### Asking for it

The mock backend serves both formats from one URL, and both answers carry `Vary: Accept` so that a
cache between them keeps the two apart. A request gets a columns body only when its `Accept` names
`application/vnd.tscache.columns`, with a quality above 0 and no lower than JSON's; a wildcard alone,
or no `Accept`, gets JSON, so a client that has not heard of the format is unaffected. Media types are
compared without their parameters and without regard to case, on both sides:

<<< ../../examples/mock-backend/src/columns.ts#negotiate{ts}

This fetcher is the one at the top of this page, asking for columns:

<<< @/snippets/fetcher-columns.ts#fetcher{ts}

A range that fits one page is returned as views over the body, with no copy at all; a longer one is
joined into one array per column, which tscache copies into its segments either way.

### Joining pages

The pages of one range need not agree on their format: a backend in the middle of an upgrade can answer
one page as columns and the next as JSON, and two columns pages can carry a field in different dtypes.
The fetcher therefore joins in two steps. It normalizes each page as it arrives (`fromColumns`,
`fromJson`), so that every column is either a typed array of a known dtype or a list of JSON numbers,
then joins the normalized pages (`joinPages`) by one rule:

| The pages hold | Joined as |
|---|---|
| one dtype throughout (columns bodies) | that dtype |
| JSON numbers throughout | `number[]` |
| anything else: columns and JSON, or columns of different dtypes | `Float64Array`, when every dtype involved is exact in float64; otherwise a `ColumnsError` |

Nothing is narrowed or rounded. Joining into the first page's array instead would convert silently: a
u16 300 written into a u8 array reads as 44. Every dtype of this format is exact in float64, and JSON
numbers are float64 already, so a mixed column always widens; a 64-bit integer dtype, if one were added,
would be refused rather than rounded. A JSON column holding anything but numbers is refused when the
page is normalized, since JSON writes `NaN` as `null`, which a typed array would store as 0. Pages whose
field names differ, in number, name or order, are refused; the names are compared one by one, never
through a string built from them.

<<< ../../examples/mock-backend/src/columns.ts#join{ts}

### The decoder

`decodeColumns` checks the body against its header before viewing it: a body that is truncated, longer
than its columns, or not in this format throws a `ColumnsError`, which the fetcher lets through, so the
range is `'fetch-failed'` and the next `get` tries again. A fetcher that also reads JSON should pick the
decoder with `isColumnsType(response.headers.get("content-type"))`, which allows for parameters such as
`; charset=binary`, rather than comparing the header's text.

<<< ../../examples/mock-backend/src/columns.ts#decode{ts}

The same file holds `encodeColumns`, which the mock backend uses to write pages. Copy the file into your
app and adapt it: the decoder is part of your code, not of tscache.

### Arrow IPC

If your backend already speaks [Apache Arrow](https://arrow.apache.org/docs/js/) (DuckDB, Polars,
ClickHouse and Arrow Flight servers all can), its IPC stream format is a binary columnar page with a
schema of its own, and there is no need for another format. Decode it in the fetcher with the
`apache-arrow` package (`tableFromIPC` on the response's bytes, then each column's typed array). Points
to watch:

- **Bundle size.** The Arrow library goes into the worker bundle, where the decoder above is a page of
  code.
- **Types.** tscache takes timestamps as a `Float64Array` or a `number[]`, and Arrow's 64-bit integer
  columns decode to `BigInt64Array`: send timestamps as float64, or convert an int64 or timestamp column
  to a `Float64Array` (one copy).
- **Nulls.** tscache fields have no nulls. A null in a float column must become `NaN`, and an integer
  column cannot hold one; check each column's null count.

## A real one

The examples' fetcher, [`examples/mock-backend/src/fetcher.ts`](https://github.com/anishbenji/tscache/blob/main/examples/mock-backend/src/fetcher.ts),
pages through the mock backend, asks for columns bodies and reads JSON if the backend answers JSON,
retries a fetch whose pages straddle a version change, and reads its backend origin from `context` on
the server:

<<< ../../examples/mock-backend/src/fetcher.ts{ts}

Without a bundler, write the fetcher as a plain ES module and import `AuthInvalidError` from your served
copy of `dist/fetcher.js`.
