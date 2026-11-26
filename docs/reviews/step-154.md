# Step 154 — load-proof timeouts for the event-order tests

Branch: `chore/154-event-order-timeouts` · Reviewer: none yet (the director reviews) · Status: implemented, awaiting review

## Incident

On 2026-11-26 a pre-push Vitest run (`~/code/tscache-reports/run/push-145.log`, outside the repo) failed `packages/tscache/test/persist-hosted-event-orders.test.ts` > every order of up to 3 events > starting with clearAll: `Test timed out in 5000ms` at 5,006 ms, the file at 12,027 ms, with the 5-minute load average at about 7.5 (two directors' heavy jobs share the machine). The same day a step 135 child's full `bun run ci` failed the same test twice at 5,007 ms (load 8 to 9.5) and passed with `--testTimeout=60000`; run alone under load, the hosted tests took 1 to 4.4 s. Run alone on a quieter machine the file passed 3 of 3. A Codex child saw the same timeout earlier that day.

The two files are the order explorers added in step 132 (`persist-orders.ts` holds the harness; `persister-event-orders.test.ts` and `persist-hosted-event-orders.test.ts` each call `orderTests`). At bound 3 their `it.each` passed no timeout, so Vitest's 5 s default applied; at bound 5 (`TSCACHE_EVENT_ORDERS=5`) it already passed 900 s. The harness comment's "7,442 orders in about a second" dated from before step 132's round 5, which added a third loader outcome to the hosted harness.

## Measurements

Orders explored at bound 3, counted with a temporary log line (removed): 9,331 in all.

| First event | Persister orders | Hosted orders |
| ----------- | ---------------: | ------------: |
| openA       |            1,742 |         1,109 |
| openB       |            1,678 |         1,085 |
| clearAll    |            1,157 |         2,560 |
| Total       |            4,577 |         4,754 |

Durations Vitest reported (JSON reporter, `--testTimeout=120000`) for the full suite (`vitest run`, 3,517 tests) under the heavy-job lock: once alone, then twice as two copies side by side, the second copy being the only load this step added (the machine is shared, so no run was on an idle machine; the quietest was at load 6). Load figures are `uptime`'s 1-minute average at the end of each run; no run failed a test.

| Test (ms)           | Alone (load 6) | Pair 1 a / b (load 34) | Pair 2 a / b (load 68) |
| ------------------- | -------------: | ---------------------: | ---------------------: |
| persister, openA    |            978 |          3,985 / 4,129 |          5,592 / 5,191 |
| persister, openB    |            519 |          3,011 / 3,345 |          4,272 / 4,503 |
| persister, clearAll |            294 |          2,339 / 2,279 |          3,379 / 3,511 |
| hosted, openA       |          1,045 |          4,274 / 4,202 |          5,741 / 5,903 |
| hosted, openB       |            570 |          3,501 / 3,468 |          5,038 / 5,006 |
| hosted, clearAll    |          1,090 |        11,370 / 11,405 |        14,637 / 14,958 |

The two files on their own (`bunx vitest run` on just these two, load about 18): 279 to 1,109 ms per test, 2.2 s in all.

Worst case: hosted clearAll at 14,958 ms; the persister file's worst is openA at 5,592 ms, so both files cross 5 s under load.

## Change

`packages/tscache/test/persist-orders.ts`, `orderTests`: the `it.each` timeout at bound 3 is now 30,000 ms (it was Vitest's 5 s default); bound 5 keeps 900,000 ms. 30 s is twice the measured worst case, at a load far above the incidents' 7.5 to 9.5, and still catches a hang. The comment beside it gives the numbers. The timeout sits in the shared harness, the one place both files declare their tests, so each file gets it without its own setting; `vitest.config.ts` is unchanged. No test's assertions, bound or orders changed. The `BOUND` comment now gives today's counts and time.

`vitest.config.ts` says a test that crosses 5 s again is "a slowdown to investigate, not to raise". These tests are not a slowdown of existing code: they enumerate every order up to the bound, their cost grows with the orders the harness explores (step 132 round 5 added hosted orders), and under load the hosted clearAll test, the largest, scales furthest. The global 5 s stays.

## Other tests that hit the 5 s timeout

Searched `~/code/tscache-reports/run/*.log` (including `ci-*.log` and `push-*.log`) and every worktree's `.reviews/step-*/*.ci.log` for `Test timed out in 5000ms`. Today's logs (2026-11-26) show only the incident above. Older logs show these, listed and not changed here:

| Log (date)                                   | Test                                                                                                                                                            | Assessment                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push-146.log`, `push-146d.log` (2026-11-25) | `cache-reader-ranges.test.ts` > includeRange > reads O(log n) list entries per range when collecting ascending ranges (6.4 s, 9.4 s, 16.4 s)                    | Deterministic and CPU-bound. Measured above as well: 2,267 ms alone, 6,355 to 8,963 ms in the pairs, so it crosses 5 s under load like the order tests. Recommended as its own follow-up step with the same treatment. |
| `push-146.log` (2026-11-25)                  | `cache-faults-property`, `cache-model-property`, `merge-property` (seeded properties), `perf/memory-budget`, `perf/persist`                                     | One run in which six unrelated files timed out together (5.8 to 8.0 s, suite 36 s): a machine-wide stall rather than these tests. Each took at most 0.8 s alone and 1.6 s in the pairs here.                           |
| `push-146d.log` (2026-11-25)                 | `site/scripts/check-mermaid.test.ts` (two cases, 5.6 s), `merge-failures.test.ts` > keeps the points outside the authority (6.3 s), `perf/persist`, `perf/gate` | Same pattern: several unrelated files in a loaded run. In the pairs here they reached at most 2.3 s (`merge-failures`) and 2.0 s (`check-mermaid`, which spawns Bun).                                                  |
| `push-126c.log` (2026-11-21)                 | `integrations/test/solid.test.ts`, three cases (5.0 s, 4.0 s, 4.0 s)                                                                                            | A different cause: the 4 s cases are `vi.waitFor` timeouts in the step 126 work then under review, not CPU time. Not on `main` in that form; the test passed in every run here.                                        |

## Verification

- `bunx vitest run packages/tscache/test/persister-event-orders.test.ts packages/tscache/test/persist-hosted-event-orders.test.ts`: 6 passed.
- `bun scripts/test-clocks.ts`: 221 files clean.
- `bun run ci` under the heavy-job lock: see the commit's report.
