# Step 94 — Tests for the engine's real mutation survivors

Branch: `test/94-mutation-survivors` · Reviewer: not yet run · Rounds: 0 · Status: awaiting review · Verdict after triage: pending

## Scope

Step 84 (`docs/benchmarks/mutation.md`) measured the engine's tests with Stryker and listed the surviving mutants that are real gaps. This step adds tests that kill them. It changes tests only: nothing under `packages/tscache/src` changes, and no test revealed a defect in the code.

Each test below fails with its mutant applied and passes on the code as it is. The red was shown by applying the mutant by hand in a scratch edit of the source, running the test file with Vitest, and undoing the edit; the source is byte-identical to `main` on every commit. File and line are in `packages/tscache/src`, unchanged since `b2e1f06`, the commit the report measured.

### The survivors the brief named

| Report row | Where                             | Mutator                                                  | Killed by                                                                                                                                   |
| ---------- | --------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 15         | `persist/persister.ts:142`        | CallExpression (`out.push(r)` removed)                   | `persister-flush.test.ts`: "a dirty page range inserted ahead of later ones keeps the later ones"                                           |
| 8          | `engine/cache.ts:402–404`         | BlockStatement (catch emptied)                           | `cache-failures.test.ts`: "rethrows, reports the failed part as removed and leaves it uncovered"                                            |
| 8          | `engine/cache.ts:404`             | CallExpression (`onChange` remove report removed)        | the same test                                                                                                                               |
| 10         | `orchestrator/orchestrator.ts:71` | EqualityOperator, second `<=` → `<` (invalidate, `:474`) | `orchestrator-subtraction.test.ts`: T28 case `{"start":103,"end":113}`                                                                      |
| 10         | `orchestrator/orchestrator.ts:71` | EqualityOperator, first `<=` → `<` (invalidate, `:474`)  | `orchestrator-subtraction.test.ts`: T28 case `{"start":-7,"end":3}`                                                                         |
| 2          | `segment/payload.ts:83`           | ConditionalExpression → `false`                          | `cache-hydrate-rejections.test.ts`: "V06 preserves payload decoder errors: payload fields 7" (a `null` entry in a list of the right length) |
| 4          | `engine/snapshot.ts:248`          | ConditionalExpression → `false`                          | `cache-hydrate-rejections.test.ts`: "V05 rejects segments: segment with no present point"                                                   |
| 5          | `engine/restore.ts:87`            | MethodExpression `every` → `some`                        | `cache-restore.test.ts`: "rejects a stored schema of several fields when one dtype differs"                                                 |
| 14         | `orchestrator/auth.ts:26`         | ConditionalExpression → `false`                          | `orchestrator-auth.test.ts` (new): "a waiter that subscribes after auth went invalid is told at once and not held"                          |
| 14         | `orchestrator/auth.ts:27`         | CallExpression (`fn()` removed)                          | the same test                                                                                                                               |
| 14         | `orchestrator/auth.ts:52`         | CallExpression (`#waiters.clear()` removed)              | `orchestrator-auth.test.ts`: "invalidate releases every waiter once and holds none afterwards"                                              |
| 7          | `engine/restore.ts:67`            | ConditionalExpression → `true` (`isHull`)                | `cache-restore.test.ts`: "a page whose range starts before / ends after its coverage applies and asks for a rewrite" (both cases)           |
| 7          | `engine/restore.ts:280`           | LogicalOperator `&&` → `\|\|`                            | `cache-restore.test.ts`: "a page holding a point outside its coverage applies and asks for a rewrite" (the two range cases above fail too)  |
| 20         | `persist/clear-disk.ts:87`        | ArithmeticOperator `deadline - now` → `deadline + now`   | `persist-clear-disk.test.ts`: "a call made at 3000 ms (startedAt …) whose clear stays pending is abandoned at … ms" (both cases)            |

### Further real gaps from the report

| Report row | Where                                  | Mutator                                                                     | Killed by                                                                                                                    |
| ---------- | -------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 6          | `engine/restore.ts:58`                 | ConditionalExpression → `true` (`isPageAfter`)                              | `cache-restore-rejections.test.ts`: "a descending page is skipped and asks for a rewrite", "a repeated page …"               |
| 10         | `orchestrator/orchestrator.ts:71`      | EqualityOperator, either `<=` → `<` (annotate, `:711`)                      | `orchestrator-misses.test.ts` (new): "a failed joined fetch meeting the miss only at its last / first slot labels that slot" |
| 11         | `orchestrator/orchestrator.ts:716–717` | MethodExpression (sort removed)                                             | `orchestrator-misses.test.ts`: "the fetch starting first labels its piece although it was awaited last"                      |
| 12         | `orchestrator/orchestrator.ts:722–724` | BlockStatement (emptied); ArithmeticOperator `- 1` → `+ 1`                  | `orchestrator-misses.test.ts`: "a miss starting before the first failed fetch keeps its front uncached"                      |
| 13         | `orchestrator/orchestrator.ts:592`     | CallExpression (`list.splice` removed)                                      | `orchestrator-misses.test.ts`: "a failed fetch leaves the in-flight list: the next get fetches afresh"                       |
| 16         | `persist/persister.ts:835`             | EqualityOperator `da < db` → `da > db`; ConditionalExpression (due ignored) | `persister-queue.test.ts` (new): "of two due jobs the one due earlier runs first, though it was queued later"                |
| 17         | `persist/persister.ts:337`             | BooleanLiteral `#closed = true` → `false`                                   | `persister-queue.test.ts`: "leaves no timer armed and later work unwritten"                                                  |
| 17         | `persist/persister.ts:339`             | OptionalChaining (`this.#store?.close()` → `this.#store.close()`)           | `persister-queue.test.ts`: "settles for a persister that never opened its store"                                             |
| 18         | `persist/persister.ts:984`             | MethodExpression `Math.min` → `Math.max` (retry due)                        | `persister-queue.test.ts`: "joins the queued job: its flush() callers settle with it and the retry stays due"                |
| 18         | `persist/persister.ts:987`             | CallExpression (waiters not moved)                                          | the same test                                                                                                                |

### Mutants left alive, and why

- `engine/cache.ts:403`, `this.#coverage.subtract(part)` removed: equivalent. `#apply` has one caller, `#hydrateValid`, which passes only parts from `#unknownParts`; such a part is never covered before the write, so withdrawing it changes nothing.
- `persist/persister.ts:338`, `this.#disarm()` removed: equivalent in practice. `close()` reaches it only once the queue has drained, and the last `#arm()` before that point found nothing to wait for and disarmed the timer itself. The new close test checks that no timer is left.
- `orchestrator/orchestrator.ts:590` and `:592` guards (`list === undefined`, `at !== -1`) and `:593` (the empty list kept in the map): equivalent. A fetch is listed before it can be decided (`#run`'s comment and the `enlist` in `#round`), and an empty list behaves as an absent one at both readers.
- `persist/persister.ts:985` (`Math.min` of the deadlines when a failed flush joins a queued job): not covered by a new test.
- `persist/clear-disk.ts:81`: the report already judges it equivalent (a retry check that only spares a wait).
- The unasserted error messages, redundant guards and performance-only choices the report classifies as such are out of scope.

### Commits

- `test(engine): kill hydrate and restore mutation survivors`
- `test(orchestrator): kill fence fencepost and auth waiter survivors`
- `test(persist): kill dirty-range and clear deadline survivors`
- `test: kill the report's further engine and orchestrator survivors`
- `test(persist): kill job order, failed-flush join and close survivors`
- `docs(review): step 94 scope and verification`

## Verification

| Command                                                                                         | Result                                                    |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `bunx vitest run <each touched test file>` on the unchanged source                              | 10 files, 346 tests pass                                  |
| The same files with each mutant above applied by hand                                           | the named test fails; every other test in the file passes |
| `cmp` of each edited source file against its saved copy, and `git diff -- packages/tscache/src` | identical; empty                                          |
| `bun run typecheck`                                                                             | exit 0                                                    |
| `bun scripts/test-clocks.ts`                                                                    | `test-clocks: 167 files clean`                            |
| `~/code/tscache-reports/bin/heavy-run.sh "94 child: ci" bun run ci`                             | see the director's report for the final head              |

The new tests follow `docs/testing.md`: the persistence tests run on Vitest's fake clock (`fakeTime()`, `vi.useFakeTimers`), the orchestrator tests order every interleaving with gated fetches and port round trips, and none sleeps or retries.

**Stryker not re-run.** `bun run mutation` (step 91) is not on `main` when this step finishes, and Stryker is not a dependency of the repository (pending user decision 60), so the new mutation scores are not measured here. Each kill above was shown by hand instead.

## Contract-test changes

No contract test was changed or removed. Cases were added to two tables in Codex-authored contract files: two one-slot ranges to T28 in `orchestrator-subtraction.test.ts`, and a `null` field entry and an all-clear mask to the V06 and V05 tables in `cache-hydrate-rejections.test.ts`. New tests were also appended to `cache-restore.test.ts`, `cache-restore-rejections.test.ts`, `persister-flush.test.ts` and `persist-clear-disk.test.ts` in their own `it` or `describe` blocks.

## Decision concerns

None.
