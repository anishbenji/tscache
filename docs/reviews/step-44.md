# Step 44 — In-flight subtraction (N31)

Branch: `feat/44-inflight-subtraction` · Reviewer: GPT-6.1 Sol (high) · Rounds: 1 · Status: design text, round 1 fixes applied, re-review pending · Verdict after triage: merge after fixes

Design for subtracting the fetches already in flight from a `get`'s misses, so overlapping reads share fetches instead of each fetching its whole miss (`docs/roadmap.md` N31; item 7 of the performance plan). This branch carries design text only: `docs/architecture.md` §4.9.1 and decision rows N31 (resolved) and N62–N65. Codex reviews the design next, then writes the contract tests listed below from §4.9.1; the implementation follows, strict test-first. The user deferred N31 on 2026-10-08; the director's standing grant approved the plan's recommendation to build it.

## Scope

| Commit | What |
|---|---|
| 56e9477 | `docs(architecture)`: §4.9.1 (the in-flight list, rounds and `planRound`, flanks, awaiting and the miss annotation, the version fence, auth, errors, abort and dispose, invalidate, `cacheOnly`, several tabs, bounds, budgets); §2.5 (dedup wording, the fetcher's request bound), the module layout line, §4.9 (pointers, the replaced dedup rule, `Orchestrator.invalidate`), §5; rows N31 and N62–N65. `docs/roadmap.md`: N31 leaves the deferred list |
| 7777941 | `docs(review)`: this file: the implementation plan, the contract tests, the budgets, the adversarial pass and two decision concerns. `docs(architecture)`: the tie rule of §4.9.1 rule 4, found while checking T27 |
| (this commit) | Round 1 triage: §4.9.1 rules 1, 3, 7 and 12 brought to `coalesce` as it is (two-slot bridges, covered blocked flanks, the fetch-count bound); T1, T4, T5, A5, A6 updated; every test re-walked |

## Implementation plan

One branch after the design review settles, strict test-first: Codex writes the failing tests below from §4.9.1, then the implementer makes them pass without weakening them.

| Module | Change |
|---|---|
| `orchestrator/orchestrator.ts` | `Inflight` and the per-cache list replacing the keyed map (rule 1); `planRound` beside `planFetches` (rule 2, step 4); a round as one synchronous step from the coverage read to the registration (rule 2); entry removal in the step that decides the outcome, not in a `finally` reaction (rule 1); the annotation over every awaited fetch of every round (rule 4); `invalidate` (rule 9) |
| `rpc/server.ts` | `invalidate` dispatched to `Orchestrator.invalidate` instead of `Engine.invalidate` |
| `docs/guides/worker-setup.md`, `docs/guides/patterns.md` | wherever the fetcher contract is listed: the request bound of §2.5 (N65) |
| `packages/tscache/bench/e2e.ts`, `bench/e2e-api.ts`, `scripts/bench-e2e.ts` | the `fast-scroll` scenario (T35) |
| `docs/benchmarking.md` | the scenario's row, how it runs and what fails it |

Follow-up, not in the step: the example and reference fetchers adopt the request bound of N65 (`AbortSignal.timeout()`), in a docs branch.

### Existing tests the design changes

- `orchestrator.test.ts`, "round 3 regressions › a fence retry does not join a fetch that the same clear already made stale". Client b's `get` over `[3, 73]`, issued while client a's `[3, 73]` fetch is in flight and `[23, 53]` is covered, now joins a's fetch (its need lies inside it, §4.9.1 rule 2) instead of issuing the two flank fetches, so `expect(releases).toHaveLength(3)` no longer holds. Its intent, that a re-plan after a clear never joins a fetch issued before it, moves to T17. The implementer changes the setup and records the change under "Contract-test changes" below.
- `e2e/dedup.spec.ts`: the header comment ("a get producing the same coalesced range") describes the old key; the test stands unchanged, and T34 adds the overlap case.
- Everything else in `orchestrator.test.ts`, `orchestrator-plan.test.ts`, `perf/counters.test.ts` and the e2e specs stands: identical-range dedup, the slow scroll's 13 fetches and its 1.002 ratio, one engine read per `get`, the step 36 sweep budgets, and the version, auth and tab-death specs (their concurrent gets ask for identical or disjoint ranges).

## Contract tests

Grid for the orchestrated tests: interval 10, offset 3 (grid points 3, 13, 23, …), as `orchestrator.test.ts`, through the RPC path with a fetcher that stalls until the test releases each call. Ranges below are in ms. "Complete" means every point of the range, `coverage` equal to the range, `misses` empty. Rule numbers refer to §4.9.1.

| # | File | Behaviour | Enforces |
|---|---|---|---|
| T1 | `orchestrator-plan.test.ts` | `planRound` matches a slot-by-slot model on 2,000 random cases (request, coverage around it, in-flight ranges ascending by start with overlaps and nesting, blocked): `join` is the indices of the in-flight ranges holding a slot of `need`; `fetch` is the model's pieces of `need` outside every in-flight range, extended and merged into coverage only. On every case also: no uncovered slot of `fetch` lies in an in-flight range or in `blocked`; a fetch shares at most two slots with any in-flight range, all covered; and `fetch.length` is at most `planFetches(r, a, b, g).length` plus the number of maximal ranges of the in-flight union that meet `need`, hence at most that plus `join.length` (R1-2, R1-3) | rules 1, 2 (step 4), 3 |
| T2 | `orchestrator-plan.test.ts` | `planRound(r, a, [], b, g).fetch` deep-equals `planFetches(r, a, b, g)` on the same random cases | §4.9.1 intro |
| T3 | `orchestrator-plan.test.ts` | Fenceposts in slots, nothing covered, need `[10, 19]`: in flight `[0, 9]` (adjacent) gives `join` [], `fetch` `[[10, 19]]`; `[0, 10]` gives `join` [0], `fetch` `[[11, 19]]`; `[12, 12]` gives `join` [0], `fetch` `[[10, 11], [13, 19]]`; `[5, 25]` gives `join` [0], `fetch` []. A request wholly covered with an in-flight range over covered slots gives `join` [], `fetch` [] | rules 2, 3 |
| T4 | `orchestrator-plan.test.ts` | Flank and bridge into a covered slot inside an in-flight range: coverage `[0, 9]`, in flight `[5, 9]`, need `[10, 19]` gives `fetch` `[[9, 19]]`, `join` []; coverage `[15, 15]`, in flight `[15, 15]`, request `[10, 19]` gives `fetch` `[[10, 19]]`, `join` []; the two-slot bridge, coverage `[14, 15]`, in flight `[14, 15]`, request `[10, 19]` gives `fetch` `[[10, 19]]`, `join` [] (two shared slots); three covered slots `[14, 16]`, in flight `[14, 16]`, gives `fetch` `[[10, 14], [16, 19]]`, `join` []. The reviewer's case: in flight `[0, 1]`, coverage `[0, 1]`, request `[-1, 2]` gives `fetch` `[[-1, 2]]`, `join` [] (R1-2) | rules 1 (at most two shared slots), 3 |
| T5 | `orchestrator-plan.test.ts` | Blocked slots: an in-flight range meeting only `blocked` slots is not joined (in flight `[12, 13]`, blocked `[11, 14]`, request `[10, 19]`, nothing covered: `fetch` `[[10, 10], [15, 19]]`, `join` []), and `fetch` holds no uncovered blocked slot. A covered blocked slot is still a flank: request `[0, 2]`, coverage `[0, 0]`, blocked `[0, 0]`, nothing in flight gives `fetch` `[[0, 2]]`, as `planFetches` does today (R1-1) | rules 2 (step 2), 3, 7 |
| T6 | `perf/counters.test.ts` | One round over 4,096 single-slot coverage ranges and 4,096 single-slot in-flight ranges interleaved with them (and a variant with 2,048 blocked ranges) equals the model, and reads each element of the three inputs at most 8 times on average (counted with the step 36 `Proxy`) | rule 12 |
| T7 | `orchestrator-subtraction.test.ts` | Two clients, partial overlap: a gets `[3, 103]` (stalled), b gets `[53, 153]`; the fetcher's second request is `[113, 153]`; b stays pending until both fetches are released, in either order; both results complete; 2 requests | rules 2, 4, 11 |
| T8 | `orchestrator-subtraction.test.ts` | Contained: b gets `[33, 73]` while a's `[3, 103]` is in flight: no request from b; b resolves complete after a's release, with a's values; 1 request | rule 2 |
| T9 | `orchestrator.test.ts` | Identical ranges still share one fetch (the existing N31 test, kept) | §4.9.1 intro |
| T10 | `orchestrator-subtraction.test.ts` | Between two fetches: a's `[3, 43]` and c's `[103, 143]` in flight; b gets `[3, 143]`: b's only request is `[53, 93]`; b resolves complete only after all three are released | rules 2, 3 |
| T11 | `orchestrator-subtraction.test.ts` | Edge to edge: with a's `[3, 103]` in flight and nothing covered, b's `[113, 153]` requests `[113, 153]` (no flank into the in-flight range); with `[3, 103]` covered instead, it requests `[103, 153]` | rule 3 |
| T12 | `orchestrator-subtraction.test.ts` | Covered-only overlap is not awaited: `[3, 103]` covered, a's fetch `[103, 153]` in flight (its flank is 103); b's `[53, 103]` resolves complete while a's fetch stays stalled | rule 2 (closing paragraph) |
| T13 | `orchestrator-subtraction.test.ts` | No join of a settled fetch, against the `Orchestrator` directly: a's `[3, 43]` fetch rejects; in the first reaction to a's `get` resolving, b gets `[3, 43]`: b makes a new request, and its result reports no `'fetch-failed'`. (Removal in the deciding step itself, rather than in a later reaction, closes a window no black-box test reaches reliably; review checks it, A1) | rules 1 (membership), 7 |
| T14 | `orchestrator-subtraction.test.ts` | Shared failure: a `[3, 103]`, b `[53, 153]` (joins a); a's fetch rejects with error E, b's own applies: a's misses are `[3, 103]` `'fetch-failed'` E; b's are `[53, 103]` `'fetch-failed'` E with `[113, 153]` present; a third get over `[53, 103]` requests `[53, 113]` (the flank into `[113, 153]`) | rule 7 |
| T15 | `orchestrator-subtraction.test.ts` | Fence, all in flight: cache at v1; a `[3, 103]`, b `[53, 153]`; a put with `meta.version: 'v2'` clears; both fetches answer and are dropped; each get plans a second round once; the requests after the clear cover `[3, 153]`, no uncovered slot in two of them; both results complete | rule 5 |
| T16 | `orchestrator-subtraction.test.ts` | Fence, the clearing fetch among the awaited: b's own `[113, 153]` answers first with `meta.version: 'v2'` (clears inside its put, applied); a's `[3, 103]` answers and is dropped; both gets plan a second round, and the requests after the drop cover `[3, 103]` with the flank 113, no uncovered slot in two of them (one request `[3, 113]` when a re-plans first; `[53, 113]` and `[3, 43]` when b does); both results complete | rule 5 |
| T17 | `orchestrator-subtraction.test.ts` | A get never joins a fetch issued before a clear: a's `[3, 73]` in flight; a version clear; b gets `[3, 73]`: b requests `[3, 73]` anew and resolves complete while a's fetch is still stalled (replaces the intent of the round 3 regression above) | rules 1 (joinable), 5 |
| T18 | `orchestrator-subtraction.test.ts` | Fence, applied then wiped (as N29 is written; DC-1): cache at v1; a `[3, 103]`, b `[53, 153]`; a's fetch answers at v1 and is applied, and a resolves complete (it read before the clear); then b's own answers with v2 and clears: no further request; b's misses are `[53, 103]` `'uncached'` with `[113, 153]` present. Under DC-1 option (b), b would request `[53, 113]` once more and resolve complete | rule 5, DC-1 |
| T19 | `orchestrator-subtraction.test.ts` | Fence, a joiner's second drop: a `[3, 103]`, b `[53, 153]` in flight; first clear; c gets `[3, 103]` and requests it (round 1); a's and b's fetches answer and are dropped; a joins c's fetch, b joins it and requests `[113, 153]`; second clear; c's and b's fetches answer and are dropped: a reports `[3, 103]` and b `[53, 153]` `'uncached'` with no third round, while c requests `[3, 103]` once more and resolves complete | rule 5 |
| T20 | `orchestrator-subtraction.test.ts` | New credentials: a's `[3, 103]` in flight with context `{ token: 'old' }`; `updateAuth({ token: 'new' })`; b gets `[53, 153]`: b requests `[53, 153]` with the new context, not `[113, 153]`; a's late success is applied; both resolve complete | rules 1, 6 |
| T21 | `orchestrator-subtraction.test.ts` | Auth invalid: a's `[3, 103]` stalled; another fetch's 401 flips the state; b's `[53, 153]` resolves at once with `[53, 153]` `'auth-pending'`, issuing no request, while a's fetch is still stalled | rules 2 (step 3), 6 |
| T22 | `orchestrator-subtraction.test.ts` | A slow `updateAuth` hook: b's get over a range in flight resolves at once with `'auth-pending'` and issues no request | rule 2 (step 3) |
| T23 | `orchestrator-subtraction.test.ts` | Joined 401 after the get's own success: a `[3, 103]`, b `[53, 153]`; b's own is released and applied, then a's fails with the auth marker: `authInvalid` is broadcast once, with a's fetch context; b's misses are `[53, 103]` `'auth-pending'` with `[113, 153]` present; a's are `[3, 103]` `'auth-pending'` | rule 6 |
| T24 | `orchestrator-subtraction.test.ts` | Joined 401 with the get's own still out: a's fetch fails with the marker first: b resolves at once with `[53, 153]` `'auth-pending'`; b's own then succeeds, and a `cacheOnly` get shows `[113, 153]` covered | rules 4, 6 |
| T25 | `orchestrator-subtraction.test.ts` | Superseded joined 401: b joins a's fetch and issues its own `[113, 153]` (token old); `updateAuth` (token new) while b waits; a's fetch fails with the marker and b's own succeeds: no `authInvalid`; b's misses are `[53, 103]` `'auth-pending'` with `[113, 153]` present; the next get over `[53, 103]` requests `[53, 113]` (the flank) with the new context and resolves complete | rule 6 |
| T26 | `orchestrator-subtraction.test.ts` | One engine read per get that only joins, only fetches, or both (spy on `engine.get`); a joining get with `snapshot: true` returns `snapshot.coverage` equal to `result.coverage` | rule 4, N36 |
| T27 | `orchestrator-subtraction.test.ts` | Label precedence: `[53, 53]` covered; a's `[3, 43]` fetches `[3, 53]`, b's `[63, 103]` fetches `[53, 103]`; c gets `[3, 103]` and joins both, requesting nothing; `invalidate([53, 53])`; both fetches reject, with errors EA and EB: c's misses are `[3, 53]` `'fetch-failed'` EA and `[63, 103]` `'fetch-failed'` EB | rule 4 |
| T28 | `orchestrator-subtraction.test.ts` | Invalidate fences joins: a's `[3, 103]` in flight; `invalidate([53, 63])`; b's `[83, 93]` requests `[83, 93]` itself; a's response is still applied and a resolves complete. An entry not meeting the range stays joinable: with c's `[203, 303]` in flight, `invalidate([53, 63])`, then d's `[253, 263]` issues no request | rule 9 |
| T29 | `orchestrator-subtraction.test.ts` | An `invalidate` with an invalid range rejects with `InvalidRangeError` and fences nothing: a later get over the in-flight range still issues no request | rule 9 |
| T30 | `orchestrator-subtraction.test.ts` | `cacheOnly` during a fetch in flight resolves at once with the current state and adds no entry; a normal get afterwards still joins the fetch (1 request in all) | rule 10 |
| T31 | `orchestrator-subtraction.test.ts` | Dispose: client a disposes while b awaits a's fetch; on release, b resolves complete, and a `cacheOnly` get from b shows the range covered | rule 8 |
| T32 | `orchestrator-subtraction.test.ts` | No timeout: b, overlapping a's stalled fetch, is still pending after a `cacheOnly` round trip from b (port order, no sleeping), and resolves once the fetch is released | rule 8, N65 |
| T33 | `orchestrator-subtraction.test.ts` | Live tail: a cache whose newest slot is provisional; a's get of the screen is stalled; b's get of the same screen joins it (1 request); after release both report only the newest slot missing, `'uncached'`, with its point present | rule 2, §4.5 |
| T34 | `e2e/dedup.spec.ts` | Two pages of one `BrowserContext`; the backend holds the first request; a gets `[3, 33]`, b gets `[23, 63]`: the backend sees `{ "3-33": 1, "43-63": 1 }`; both settle complete. Control: two contexts see `{ "3-33": 1, "23-63": 1 }` | rule 11 |
| T35 | `perf/counters.test.ts` | Fast scroll, exact budget (below) | rule 13 |
| T36 | `bench` (`fast-scroll`) | End-to-end fast scroll: bars served checked, timing report-only (below) | rule 13 |

### Budgets

**T35, the fast scroll.** The setup of "a chart scrolling back" (`SCREEN` = 500 one-minute bars, `around(end)` the screen and one each side, 1,500 bars, `newest = year.range.end − SCREEN`), with a fetcher that holds each answer until the test releases it.

1. `await get(around(newest))`, answered at once: 1 request, 1,500 bars.
2. For k = 1 to 12, `get(around(newest − k·SCREEN))` is posted without awaiting it, each after the fetcher has received the previous read's request. No answer is released until all twelve have been posted.
3. The twelve answers are released, newest request first (a second case releases them in request order).

Exact results: 13 requests. The second is `[newest − 3·SCREEN, newest − 2·SCREEN]` (500 new bars plus the flank into the opening read's coverage); for k = 2 to 12 the request is `[newest − (k + 2)·SCREEN, newest − (k + 1)·SCREEN − MINUTE]`, 500 bars, no flank. Bars fetched in all: 1,500 + 501 + 11 × 500 = 7,501, which is the union of the 13 reads (15 screens, 7,500 bars) plus the one-interval flank. Every read resolves complete with 1,500 bars, and the engine is read once per read (12 reads for the 12 scroll gets). The exact-range dedup of `main` fetches 18,003 bars here, so the test fails before the implementation.

**T6, the round over fragments.** As step 36's budgets: the result equals the model's, and element reads of the coverage, in-flight and blocked arrays stay at or under 8 × their total length; the measured figure goes in the test's comment.

**T36, `fast-scroll` in Chromium.** One page per side, each with its own SharedWorker, a cache per operation, the same reads as T35 against the mock backend.

- *Checked run* (every run, the smoke included): the opening read is answered at once; the driver holds the next 12 candles requests; the page posts the twelve scroll reads back to back; once the backend holds 12 requests the driver releases them; the page awaits and checks every read (1,500 bars, first and last timestamp, last price, no misses). The driver sums the bars the backend served for the side's 13 requests (each `start-end` key's count times its grid points): the head must serve exactly 7,501. The base side's count is reported beside it, not checked, so the pull request shows the reduction against `main`.
- *Timed runs* (report-only, paired base and head rounds as the other page scenarios): the same twelve reads over history no earlier operation read, without holds, timed from the first scroll read posted to the last resolved. Bars served are reported, not checked: without a hold a fetch can land before a later read is planned.

## Adversarial pass

One interleaving per rule of §4.9.1, written to break it, then walked through the text as committed on this branch. Each test's expected values above were also derived step by step from the rules; that check corrected T16, T18 and T25 before commit and added the equal-start tie rule to rule 4.

| # | Rule | Interleaving | Outcome |
|---|---|---|---|
| A1 | 1, membership | The step ⑪ code removes an entry in a `finally` reaction. A fetch rejects; before that reaction runs, a get resumed by another fetch in the same microtask checkpoint re-plans, finds the failed fetch listed and joinable, joins it, and reports `'fetch-failed'` for a failure it never awaited, against "the next get tries again" | Closed by rule 1: removal happens in the step that decides the outcome, so no plan sees a decided fetch. T13 pins the observable part |
| A2 | 1, joinable | A clear arrives while a fetch is in flight; a get then re-plans and finds that fetch, doomed to be dropped, still listed over the slots it needs (the step ⑪ round 3 finding, now for overlaps) | Closed: the entry's `generation` is stale, so it is not joinable; the get fetches anew. T17 |
| A3 | 1, no slot twice | Two tabs post overlapping gets in one macrotask; the second plans before the first's fetch is visible and both fetch the overlap | Closed: a round is synchronous from the coverage read to registration (rule 2), and the server handles one message at a time, so the second plan sees the first's entry. T7, T34 |
| A4 | 2, auth gate | Auth flips invalid while a fetch that may still succeed is in flight; a get over its range joins it and waits, so `'auth-pending'` versus data depends on timing | Closed: rule 2 step 3 answers at once and joins nothing, as §4.9 did for the identical range. T21 |
| A5 | 3, flanks | A put covers `[0, 12]` while a fetch `[5, 12]` is in flight; a get `[13, 20]` extends its fetch to `[12, 20]`, so two fetches hold slot 12 | Allowed and harmless: both are authoritative answers from the backend, the later lands last (new wins), and rule 1 bounds the overlap to slots covered at the later plan, at most two (a two-slot bridge, R1-2). T4 |
| A6 | 3 and 12 | A fetch of one or two slots, later covered, sits inside a fetch that bridged over it; a binary search for the entries meeting a request, keyed by end, skips the outer one | Closed: rule 12 scans linearly with a two-pointer pass that is correct for any start order. T1 generates nesting |
| A7 | 4, annotation | Two failed fetches share a slot that an invalidate made missing; which error labels it | Closed: the one that starts first. T27 |
| A8 | 4, the read | An auth flip releases a get while a joined fetch is still out; the read and its snapshot are taken at the release | Holds: one read after the release, the snapshot from it (N36); the joined fetch's later success serves the next get |
| A9 | 5, the fence | Race B: a's fetch applies at v1, then b's own fetch brings v2 and clears; b had joined a's fetch, so nothing b awaited was dropped, and b reports `[53, 103]` `'uncached'`, where exact-range dedup would have had b's own fetch over `[53, 153]` cover it | Holds to the letter of N29 (no drop, no second round), but weakens its reason, "one version bump is invisible": raised as DC-1. T18 pins the locked behaviour |
| A10 | 5, the fence | A get in its second round joins a fetch issued by another get in its first round; a second clear drops it; the issuer fetches once more | Holds: the joiner reports `'uncached'` and plans no third round; the issuer's own budget is separate. T19 |
| A11 | 5, the fence | Two gets awaiting one dropped fetch re-plan in either order and both fetch the missing range | Closed: the first to re-plan registers its fetch synchronously; the second subtracts and joins it. T15, T16 |
| A12 | 6, auth | A get joins a fetch; `updateAuth` switches the generation; the old fetch's late 401 should neither flip the new credentials nor be reported as success | Holds: the failure is from a superseded generation, flips nothing, and comes back `'auth'`; the next get fetches with the new context. T25 |
| A13 | 6, auth | After a 401 releases every get, the fetches still out keep the current auth generation; once auth is valid again, a get could join one of them | Closed: `updateAuth` switches the context and the generation in the same step that makes auth valid (§4.9), so by then they are stale |
| A14 | 7, errors | In its second round a get blocks the slots that failed in its first; another get's fetch for those slots lands before the read | Holds: the get neither joins nor refetches them, but the read shows them present, since only missing slots are labelled |
| A15 | 8, dispose and hangs | The tab that issued a fetch disposes; a joiner in another tab waits on it. Separately, a fetch never settles | Holds: the fetch belongs to the worker and lands; the joiner resolves; no console prints its `mergeWarning`, as for an identical range before. A hung fetch now holds every overlapping get: N65 puts the bound in the fetcher, with a join age as the recorded upgrade. T31, T32 |
| A16 | 9, invalidate | After a restatement the app calls `invalidate` and then `get`; a fetch issued before the invalidate overlaps the range; with subtraction the get joins it and the pre-restatement points are covered as authoritative, never refetched | Closed for the get: the entry is fenced and the get fetches anew (N64). The fenced fetch still lands and covers the range again with what it fetched before, which predates N31: DC-2. T28 |
| A17 | 10, `cacheOnly` | A `cacheOnly` get registers nothing, so a later get cannot join it; it also sees a half-landed state | Holds: it returns the current state at once by design (N2); there is nothing to join. T30 |
| A18 | 11, several tabs | The tab hosting the SharedWorker crashes while another tab's get awaits a fetch the host tab issued | Unchanged: the worker dies with the host's renderer and every client reports `workerLost` (N32); nothing is half-shared |
| A19 | 12, bounds | A burst of 4,096 single-slot gets leaves 4,096 fetches outstanding; every later round scans them | Linear per round as specified; across the burst the work is quadratic in the fetches outstanding at once (about 16.8 million element visits at 4,096, a pathological consumer), spread over 4,096 gets. T6 bounds one round |
| A20 | 13, budgets | The fast-scroll budget passes for the wrong reason: each fetch lands before the next read plans, so coverage does the work and subtraction is never exercised | Closed: answers are held until all twelve reads are posted, and `main` fetches 18,003 bars under the same setup, so the budget fails without subtraction. T35, T36 |

## Decisions made in the step

Taken by the director's standing grant with the recommended options; each is a row in architecture §8.

- **N31** resolved: subtract in-flight ranges (perf plan recommendation).
- **N62**: the per-cache in-flight list, joinable by its stamps and the invalidate fence, removed when its outcome is decided, scanned linearly; a round awaits the joinable fetches meeting the slots it needs, with no cap.
- **N63**: subtract before coalescing; the locked flank extends into coverage only; pieces between in-flight ranges are separate requests.
- **N64**: `invalidate` fences joins over its range.
- **N65**: a fetch that never settles is bounded by the fetcher; no orchestrator timeout.
- Numbering: N62 onwards, because N45–N61 are held by the persistence design on `feat/38-persistence`, which is parked unmerged.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | T5 contradicts T2: a covered blocked slot is a flank today | accepted | Reproduced against the current planner: `planFetches([0, 2], [[0, 0]], [[0, 0]])` is `[[0, 2]]`. T5 now forbids only uncovered blocked slots and carries the case; §4.9.1 rule 1 names `blocked` in the no-double-fetch rule, and rules 3 and 7 say a covered blocked slot can still be a flank or bridge, as today. Fixed in this commit |
| R1-2 | P1 | The one-shared-slot invariant conflicts with the two-slot bridge | accepted | Reproduced: `planFetches([-1, 2], [[0, 1]], [[0, 1]])` is `[[-1, 2]]`; each piece extends one slot into the two-slot gap and the touching ranges merge, which `coalesce` has always done. Rule 1 now allows at most two shared slots, all covered when the later fetch was planned; rule 3 restates `coalesce` as it is (gaps of one or two covered slots merge, three do not) instead of paraphrasing it; rule 12's nesting note says one or two slots. T4 adds the reviewer's case, the two-slot bridge and the three-slot gap; T1 asserts the two-slot bound on random cases; A5 and A6 updated. Fixed in this commit |
| R1-3 | P2 | The fetch-count bound ignores coverage fragments | accepted | Reproduced: `planFetches([0, 7], [[2, 5]], [])` is two fetches with nothing in flight. Rule 3 now bounds the extra fetches against `planFetches` for the same request, coverage and `blocked`: at most one for each maximal range of the in-flight union that meets `need`, hence at most `join.length`. T1 asserts both forms. Fixed in this commit |

All three come from rules that paraphrased `coalesce` rather than deferring to it. Rule 3 now says it is `coalesce` unchanged and states its consequences, so the rules cannot drift from the planner again.

### Re-check after round 1

Every test was walked through the revised rules with a scratch model (outside the repository): §4.9.1 as an orchestrator over the real `Engine`, the real `planFetches` and the real `coalesce`, where every plan's fetches are computed twice, slot by slot and through `planFetches` with the in-flight union and `blocked` as cuts, and the two must agree. 87 assertions, all hold:

- **Mechanically:** T1 (4,000 random cases: model against `planFetches`, no uncovered fetched slot in flight or blocked, at most two slots shared with an in-flight range, both forms of the R1-3 bound); T3; T4 (with the R1-2 cases); T5 (with the R1-1 case); T7, T8, T10–T21, T23–T25, T27, T28, T30, T33, T34; T35 (13 requests, the second `[newest − 3·SCREEN, newest − 2·SCREEN]`, 7,501 bars, and 18,003 bars under exact-range dedup).
- **Cases with nothing in flight, run on today's coalescing:** T5's covered flank, T11's covered variant (`[103, 153]`), T12's flank (`[103, 153]`), T13's second get, T14's third get (now stated as `[53, 113]`, the flank included), T16's alternative split (`[53, 113]`, `[3, 43]`), T18's DC-1 alternative (`[53, 113]`), T25's next get (now stated as `[53, 113]`), T27's two plans (`[3, 53]`, `[53, 103]`), and T35's opening read and `main` figure. None contradicts today's planner.
- **By reading, since they plan nothing new:** T2 (holds by construction of `planRound`), T6 (asserts against the model whatever the value), T9 (an existing test, unchanged), T22 (the gate path of T21), T26 (read count), T29 (the error path), T31 and T32 (lifecycle), T36 (the reads and numbers of T35).

## Contract-test changes

None yet. The implementer records here the change to the round 3 regression test named above.

## Decision concerns

**DC-1. The version fence's trigger with shared fetches (N29, locked).** N29 re-plans a `get` once when a fetch it awaited was dropped, and its reason is that one version bump stays invisible to the consumer. When a get awaits several fetches and every one of them is applied, the clearing one last (race A9), nothing was dropped, so the slots the clear wiped come back `'uncached'`. The case exists today for a get's own fetches; subtraction makes it more frequent, because a get now awaits fetches that other gets issued and that may land before the clear.

| Option | Pros | Cons |
|---|---|---|
| (a) Keep the trigger as written: re-plan only after a drop (the design as committed) | No change to a locked rule; bounded | One visible hiccup per bump in this race, against N29's stated reason |
| (b) Re-plan once when the cache was cleared while the get waited: its round ended under another generation than it planned under | Restores "one bump is invisible" for joined and own fetches alike; still once per get; the check is one comparison | Changes the trigger of a locked rule; a manual `clear` during a get also causes one refetch (already the case today when the get had a fetch in flight) |

Recommendation: (b). The design keeps (a) because N29 is locked; T18 pins (a) and lists the assertions that (b) would change.

**DC-2. A fetch in flight across an `invalidate` (pre-existing since step ⑪).** `invalidate` subtracts coverage; a fetch issued before it that lands afterwards is applied as authoritative and covers the range again with what it fetched, possibly from before the restatement the app invalidated for. N64 stops a `get` issued after the invalidate from relying on such a fetch, so subtraction adds no exposure, but the landing itself is unchanged.

| Option | Pros | Cons |
|---|---|---|
| (a) Document it: invalidate after the restated data is live, and expect fetches already in flight to land | No change | The window stays; a restatement can be lost until the next invalidate |
| (b) Fence responses too: a fetch issued before an invalidate is applied outside the invalidated slots only (its authority and points clipped) | Closes the window; per entry, like N64 | A second fence beside N29, a put split around the fenced slots, and tests; its own small step |
| (c) Treat `invalidate` as a clear for the fence (bump the generation) | One line | Drops every fetch in flight for the cache, far beyond the range |

Recommendation: (b) as a separate step if restatements matter for a consumer; (a) meanwhile, since the primary use case's data never changes once returned (N11).
