# Coverage and gaps

A cache keeps two things apart:

- **Data**: the points that exist, each with a value for every field.
- **Coverage**: the time ranges the cache *knows* about, because the backend answered for them.

A slot inside coverage without a point is a **confirmed gap**: a weekend, a night between trading
sessions, an hour a sensor was offline. It is never fetched again. A slot outside coverage is simply not
known yet, whether or not a point happens to be there.

## What a read returns

`get(range)` resolves with a `GetResult`:

| Field | Holds |
|---|---|
| `timestamps` | the timestamps of every present point in the range, ascending (`Float64Array`) |
| `fields` | one typed array per field, of the field's dtype, as long as `timestamps` |
| `coverage` | the authoritative sub-ranges of the request, ascending |
| `misses` | the rest of the request, each `{ range, reason, error? }`; always present, possibly empty |
| `snapshot` | only when asked for with `{ snapshot: true }` ([Snapshots](/usage/snapshots)) |

`coverage` and `misses` tile the request exactly: every slot is in one of them. The arrays hold
present points only: no holes, no mask, the same shape whatever the cache's internal layout.

A read returns **every** present point in the range, covered or not. The live tail, which is never
covered (see [Versions and watermarks](/concepts/freshness)), still shows its newest bar, and a range you
invalidated stays on screen until its refetch replaces it. `coverage` says which parts are
authoritative.

The arrays are copies, never views into the cache's memory; they are moved to the page without a second
copy, and you own them.

## Miss reasons

| Reason | Means | What to do |
|---|---|---|
| `'uncached'` | nobody asked the backend for it: no fetcher is configured, you read with `cacheOnly`, or a version change dropped its answer twice ([versions](/concepts/freshness)) | fetch and `put` it yourself, or read without `cacheOnly` |
| `'fetch-failed'` | the fetch threw, or its response failed validation; `error` has its `name` and `message` | read again later; nothing about the failure is cached |
| `'auth-pending'` | credentials are invalid, so the fetch was not made, or it was refused | refresh, call `updateAuth`, read again ([Credentials](/guides/auth)) |

`get` never rejects because data is unavailable. It rejects only for programmer errors: an invalid
range, an unknown cache, a disposed client ([Errors](/usage/errors)).

## How a read fetches

With a fetcher configured, and without `cacheOnly`, a read:

1. computes the uncovered parts of the request;
2. **coalesces** them: adjacent misses merge, and a miss that abuts existing coverage is extended by one
   interval into it, so the response overlaps what is known by one point and the ranges join;
3. issues one fetch per coalesced range, unless the same range of the same cache is already in flight,
   from any tab: then it awaits that fetch instead (**dedup**);
4. writes each response as authoritative for its whole range, below the response's own watermark;
5. reads again and resolves.

Dedup is by exact range: two overlapping but different ranges fetch separately.

## Claiming a range yourself

`put` writes points without a fetcher. What it claims:

- **Without `options.range`**, the batch's own span, from its first to its last timestamp. It adds or
  overwrites the points it carries and removes nothing. This is safe for streaming appends.
- **With `options.range`**, that whole range, which must contain every timestamp of the batch. Slots in
  it without a point become confirmed gaps, and points already inside it that the batch does not carry
  are removed: afterwards the range holds exactly the batch's points. A range that is not on the grid
  covers only the grid points inside it.

<<< @/snippets/cache.ts#put{ts}

A wrong claim is undone only by [`invalidate`](/concepts/invalidation). Every orchestrated fetch is a
claim of the second kind, for the range it asked for, which is why a fetcher must return the whole
range ([Writing a fetcher](/guides/fetcher)).

## Why a separate index

Coverage is a sorted array of disjoint ranges per cache, searched by bisection. Ranges merge whenever
they touch, and a confirmed gap does not split coverage, so the array stays at tens of entries; the
architecture document records why an interval tree or a skip list was not worth it (§6.1 of
[architecture.md](https://github.com/anishbenji/tscache/blob/main/docs/architecture.md)).
