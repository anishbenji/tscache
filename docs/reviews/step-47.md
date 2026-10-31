# Step 47 — The version fence re-plans after a clear (N29 amended)

Branch: `feat/47-fence-replan` · Reviewer: GPT-6.1 Sol (high), run by the director · Rounds: none yet · Status: settled after round 1 

The user's answer to pending decision #10 (2026-10-31): option B of DC-1 in `docs/reviews/step-44.md`. "The version fence also re-plans once when the cache was cleared while a `get` waited, still at most two rounds." Before this step a `get` planned its second round only when a fetch it awaited came back dropped. With in-flight subtraction (N31, step 44) a `get` awaits fetches that other gets issued; such a fetch can land, be applied, and then be wiped by another response's version clear before the `get` reads, and the `get` returned the wiped slots `'uncached'` with nothing dropped (race A9, pinned by T18; the narrow window after R4-1). Now a round that ends under another clear generation than it was planned under triggers the one re-plan, for joined and own fetches alike. DC-2 (a fetch in flight across an `invalidate`) is unchanged and stays documented only. Implemented by a child agent of the director while the user was away; strict test-first as for step 44, with the tests written by the implementer from the amended rule, since the user decision named the behaviour and T18 already listed the assertions option B changes.

## Scope

| Commit | What |
|---|---|
| 3dbbc36 | `docs(architecture)`: §4.9 "Version fence", §4.9.1 rules 2, 5 and 6, the two section headings, and row N29 in §8 (amended, the original text kept) |
| 91ede6c | `feat(orchestrator)`: `#rounds` compares the cache's generation at the end of its first round with the one it planned under; T18 updated to option B; tests F1–F6 |
| 92bde2d | `docs(site)`: `concepts/freshness.md` and the miss-reason table in `concepts/coverage.md` |
| 45dc0d8 | `refactor(orchestrator)`: `#generationOf` serves every read of the clear count; the two new `?? 0` reads had taken `#rounds` over Fallow's complexity threshold (cyclomatic 10, CRAP 31.6), which failed the first `bun run ci` |
| (this commit) | This file: decisions, tests, contract-test changes, bench, verification |

## The rule, as amended (§4.9.1 rule 5)

- **What is compared.** The cache's clear count (its generation, the counter the orchestrator already keeps per cache from `cacheCleared`) in force in the round's synchronous step, the one that reads coverage and registers the round's fetches (rule 2), against the count in the continuation of the round's await, when every fetch it awaited has settled or an auth flip released it (rule 4). That continuation is the step in which the `get` either reads or plans its second round, so nothing lands between the comparison and what follows it.
- **Why one comparison replaces the drop check.** Every fetch a round awaits was issued under the generation the round planned under: its own fetches carry it, and a joined fetch is joinable only while its generation is current (rule 1). A dropped outcome means the generation moved after the fetch was issued, so a drop implies a changed generation, and the trigger as first written is one case of the new one. The code therefore has one comparison and no separate drop test.
- **What the second round asks for.** As before: everything still missing in the request, minus `blocked` (the ranges of the first round's fetches that came back `'failed'` or `'auth'`), subtracting and joining among the entries issued after the clear. Gets that re-plan after one clear share the refetch.
- **The second round is final.** No third round: what a clear during the second round drops or wipes comes back `'uncached'`.

## Decisions

- **User decision #10, option B** (2026-10-31), as quoted above. The amendment is recorded in row N29 with the original text kept, in §4.9 with a sentence on the rule as first written, and in rule 5 under *As first written*.
- **An auth release ends a round too** (implementer's call; the recommended reading of "ended"). A `get` released by an auth flip in its first round, after the cache was cleared, plans its second round; auth is then invalid, so that round is gated (rule 2, step 3) and the slots the clear wiped come back `'auth-pending'`, not `'uncached'`. The alternative, no re-plan after a release, would have needed a second condition and reported `'uncached'` for slots that no fetch can reach until `updateAuth`, where `'auth-pending'` tells the consumer what to do. Stated in rules 5 and 6; F6 pins it.
- **A clear that leaves nothing missing costs one coverage read and plan, no request.** For instance a get whose own response carries a new version: its put clears the cache, then applies the response, so the get re-plans over a request that is covered already. Stated in rule 5 (*What is refetched*); F4 pins both this case and a clear that wiped part of the request.
- **Tests beside T18.** The new tests are in `orchestrator-subtraction.test.ts`, in their own `describe` block, since they use its harness, `version` and `uniqueUncovered`.
- **Request bounds unchanged** (N62, N65). A round still awaits at most the joinable entries plus its own fetches (rule 12), a round's extra requests are still bounded by rule 3, and a `get` still runs at most two rounds; rule 13's budgets involve no clear. No statement of the request bound in `docs/guides/` or the site's fetcher page mentions the fence, so none changed.

## Tests

Grid as in step 44 (interval 10, offset 3), through the RPC path with the gated fetcher unless the test says "direct". "Complete" as in step 44.

| # | Behaviour | Enforces |
|---|---|---|
| T18 (changed) | Cache at v1; a `[3, 103]`, b `[53, 153]` (joins a's fetch, issues `[113, 153]`); a's fetch answers at v1 and a resolves complete; b's own answers with v2 and clears: b requests `[53, 113]` once more (the flank into its own `[113, 153]`), stays pending until it is answered, then resolves complete; 3 requests | rule 5 |
| F1 | Cache at v1; a `[3, 103]`; c `[203, 253]`; b `[33, 73]` joins a's fetch and issues nothing; a's fetch applies at v1 and c's brings v2, in one step: a and b both re-plan and share the refetch (every slot of `[3, 103]` in exactly one later request, none outside it); a, b and c resolve complete | rule 5, joined fetch |
| F2 | As F1 without b: a requests `[3, 103]` once more and resolves complete after it is answered; c's get re-plans over its covered range and requests nothing; 3 requests | rule 5, own fetch |
| F3 | As F2, then a second clear during a's second round, two ways: a's second fetch is applied and a fetch issued after the first clear brings v3 in the same step (wiped after it applied), or a v3 put clears before a's second fetch lands (dropped). Both: a's misses are `[3, 103]` `'uncached'`, coverage empty, and no third request (4 and 3 requests) | rule 5, no third round |
| F4 | a's own response brings v2 and clears the cache. Wiped outside the range (`[203, 253]` covered at v1): 1 request, complete. Wiped inside the range (`[3, 43]` covered at v1, a fetches `[43, 103]`): the second round requests only `[3, 43]` (the wiped `[3, 33]` plus the flank into the response's 43), complete. Both: exactly two coverage reads, one per round (spy on `engine.coverage`) | rule 5, cost |
| F5 | Direct: the R4-1 interleaving, gets over `[13, 13]` and `[23, 23]`, the second response (v2) 0 to 5 promise reactions after the first (v1); a re-plan's fetch is answered as it is issued: both gets resolve complete, and the first fetches its point at most once more, as `[13, 23]` | rules 4, 5 |
| F6 | `[113, 153]` covered at v1; a `[3, 153]` fetches `[3, 113]`; a v2 put clears; b's `[203, 253]` is refused with the auth marker, which releases a while its fetch is out: every slot of `[3, 153]` comes back `'auth-pending'` (the fetch's range from the first round, the wiped `[123, 153]` from the gated second round); 2 requests | rules 5, 6 |

The R4-1 regression test is unchanged apart from its comment: at five reactions the first get still reads before the clearing response lands, so it does not re-plan, and the test still fails if the path from a fetch's decision to the read gets longer.

**Before and after.** The tests were run once against the implementation of `a212cba` (main) before `orchestrator.ts` changed: `bunx vitest run test/orchestrator-subtraction.test.ts` gave 13 failed and 37 passed. The 13 are T18, F1, F2, both F3 cases, both F4 cases, F5 at 0, 1, 2, 3 and 4 reactions, and F6, each for the old trigger: no second request (T18, F1, F2, F3, F4 inside), `'uncached'` for the wiped slots (F5, F6: "slot 123: expected 'uncached' to be 'auth-pending'"), or one coverage read where two were expected (F4 outside). F5 at 5 reactions passes on both, since that landing comes after the read (R4-1). After the change: 50 passed; ten consecutive runs of the file passed.

## Round 1 — reviewer verdict: merge

No findings. Settled after one round.

## Contract-test changes

- **T18** (`orchestrator-subtraction.test.ts`, Codex, step 44): assertions changed to option B, because the spec changed (user decision #10; §4.9.1 rule 5 in 3dbbc36). It asserted no further request after b's own v2 response, b's misses `[53, 103]` `'uncached'`, coverage `[113, 153]` and five timestamps; its last comment said option B "would instead fetch `[53,113]` and return a complete read". It now asserts exactly that: the third request `[53, 113]`, b pending until it is answered, b complete over `[53, 153]`, 3 requests. Its title says "re-plans once and completes (N29 as amended, DC-1 option b)".
- **R4-1 regression** (director, step 44): comment only, replacing "Earlier landings of b are T18's case (DC-1)" with a pointer to F5. The assertions are unchanged.
- No other test changed. Every existing orchestrator, RPC, client and end-to-end test passes unchanged (Verification); the version specs (`orchestrator.test.ts` "version fence (N29)", `e2e/version.spec.ts`) cover cases where the second round finds nothing missing or follows a drop, which behave as before.

## Bench

Under the machine's heavy-job lock, on the Apple Silicon Mac, 2026-10-31. `bun scripts/bench.ts e2e --base origin/main --only fast-scroll,live-tail-get,two-tabs-one-fetch`, 20 rounds, head `92bde2d` against base `a212cba` (`origin/main`), the columns fixture fetcher on both sides. Report-only (`docs/benchmarking.md`).

| Scenario | Base | Head | Head/base | 95 % CI |
|---|---:|---:|---:|---:|
| `fast-scroll` | 2.20 ms | 2.25 ms | 1.020 | 1.000–1.095 |
| `two-tabs-one-fetch` | 353.1 µs | 348.8 µs | 0.977 | 0.966–0.995 |
| `live-tail-get` | 25.9 µs | 26.0 µs | 1.001 | 0.974–1.028 |

Bars served by `fast-scroll`: checked run, base 7,501 and head 7,501; every one of the 22 timed runs per side, 7,501. None of the three scenarios clears a cache, so the change cannot alter what they fetch, and the added work is one map lookup and one comparison per round. The `fast-scroll` interval touches 1.000 at its lower end, and the `two-tabs-one-fetch` interval lies just below 1; both read as noise for a change that adds no work on these paths, and neither is gated. The bench ran before 45dc0d8, which changes no behaviour (one private helper in place of four identical expressions), so it was not run again.

## Verification

- `bunx vitest run test/orchestrator-subtraction.test.ts` (in `packages/tscache`) on main's implementation, with the new tests: 13 failed, 37 passed (above). After the change: 50 passed, ten runs in a row.
- `bunx vitest run` over `orchestrator-subtraction`, `orchestrator`, `orchestrator-plan` and `perf/counters`: 106 passed; over `base64`, `dev-warnings`, `errors`, `perf/counters`, `rpc`, `snapshot-wiring` and `client`: 91 passed.
- `bun run ci` under the heavy-job lock on 92bde2d: failed at Fallow (`#rounds` above the complexity threshold); fixed in 45dc0d8.
- `bun run ci` under the heavy-job lock on 45dc0d8: exit 0. Vitest 86 files, 1,763 tests passed; Playwright 150 passed; `test-clocks` 117 files clean; Fallow no issues in the 6 changed files; gitleaks no leaks; build, publint and attw clean; the bench smoke passed.
- `bun run ci` on this commit, the branch head: in the report to the director.

## Not verified

- No flake hunt under load (`scripts/flake-hunt.sh`): the new tests use no timer, no clock and no sleep, and their interleavings come from answers released in one step and from port round trips; ten plain runs passed.
- No end-to-end test of the new trigger in Chromium. `e2e/version.spec.ts` still passes, but both of its tests take paths that behave as before: the second round finds nothing missing, or follows a drop.
- The Codex review loop has not run on this branch (the director runs it).

## Decision concerns

None open. DC-1 of step 44 is resolved by this step. One consequence for the user to know, not to decide: a backend whose responses disagree on the dataset version (replicas at different versions behind one endpoint) clears the cache on every disagreement; before this step a `get` that saw such a clear without a drop returned the wiped slots `'uncached'`, and now it asks once more, so such a backend can cost up to one extra request per `get`, still bounded by the two rounds. DC-2 stays as documented in `docs/reviews/step-44.md`.
