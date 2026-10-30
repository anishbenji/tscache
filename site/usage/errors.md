# Errors

Errors are for programmer mistakes. Data that is unavailable never rejects: it comes back as a miss.

| Class | Thrown when |
|---|---|
| `TscacheError` | the base class of all below; also: a disposed or lost client, a fetcher module that failed to load, an invalid snapshot |
| `ConfigError` | an invalid `CacheConfig` or `ClientOptions`; a cache opened with another structure under the same id |
| `InvalidRangeError` | a range endpoint that is not a finite number within ±(2^53 − 1), or `start > end`; a `setFinalizedUntil` timestamp out of that domain |
| `UnknownCacheError` | a cache id the engine does not know |
| `PutError` | a batch rejected as a whole; see below |
| `ProtocolMismatchError` | the worker speaks another protocol version: a stale cached script or package skew; carries `clientProtocol` and `workerProtocol` |
| `AuthInvalidError` | thrown by *your* fetcher, not by the library ([The fetcher module](/usage/fetcher)) |

Errors keep their class across the worker boundary: a `PutError` thrown in the worker is a `PutError` in
the page, with its fields.

## PutError

| Field | Holds |
|---|---|
| `code` | `'misaligned'`, `'unsorted'`, `'duplicate'`, `'field-mismatch'`, `'length-mismatch'` or `'range-mismatch'` |
| `offenderIndex` | the index of the first offending timestamp; `-1` for a structural problem |
| `offenderTimestamp` | its value, when it is a number |
| `expected` | what was expected, e.g. `"t ≡ 0 (mod 60000)"` |

<<< @/snippets/cache.ts#put-error{ts}

## Examples

<<< @/snippets/errors.ts#connect{ts}

<<< @/snippets/errors.ts#range{ts}
