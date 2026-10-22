# Roadmap

Work deliberately left out of v1. Step ⑭ of the commit plan completes this page with the design sketches (persistence in particular); until then it lists what is deferred and where the reasoning lives.

## Reference clients (requested 2026-10-22)

Three reference clients that show how to use tscache in an application, one each for **vanilla JavaScript**, **React** and **Solid**. Each covers the whole client lifecycle: connect once, replace the client on `workerLost`, dispose on teardown; read with `get` and render coverage and misses; `put` pushed data; refresh credentials through `authInvalid` and `updateAuth`; and hydrate from a server render. The bar is the one the examples set, raised to reference quality: best practices for each platform, high performance, idiomatic code, and clean, clear code a reader can copy as it stands.

They differ from the step ⑭ integration snippets, which are type-checked fragments, in being complete and tested. Open question for the user: whether they ship as packages (framework bindings such as a React hook and Solid primitives) or stay as source to copy.

## Deferred features (starter §10)

- Aggregation and resampling across intervals, likely with user-defined rules per dataset. Today a series at 1 m and at 1 h are two caches.
- `ColumnarSegment` for sparse data (explicit timestamps, no mask), and a third segment layout for irregular timestamps.
- Subscriptions as dirty notifications: notify only, then the consumer calls `get` again.
- IndexedDB persistence: write-behind of dirty segments, the volatile region excluded, coverage reconciled against the segments actually present on load (architecture §3.4).
- LRU eviction and memory limits.
- SharedArrayBuffer as an opt-in (it needs COOP/COEP headers).
- Per-field presence masks, so integer fields can represent a missing value.
- An elected auth handler, design (c) in architecture §6.2.
- Node `worker_threads` hosting.

## Deferred decisions (architecture §8)

- **N28.** A heartbeat so the SharedWorker can drop a tab that died without `pagehide`, if real tab churn shows the bounded leak matters.
- **N31.** Subtracting in-flight ranges from new fetch requests, instead of sharing only identical ranges.
