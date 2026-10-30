# Testing

How tests in this repository are written so that they pass or fail because of the code, never because of the time of day, the machine's load or another test. Every rule below comes from a flake the repository had; the inventory and the fixes are in `docs/reviews/step-28.md`. The runners and hook staging are in `AGENTS.md`.

`bun scripts/test-clocks.ts`, part of `bun run ci`, enforces the rules it can see: no wall-clock read, no self-timing and no sleep in a test file, and Playwright retries at 0. A line that needs one anyway carries `// clock-ok: <reason>` on the line or the line above, and the reason says why it cannot flake.

## Clocks

A test never reads the wall clock (`Date.now()`, `new Date()`). A bar, a day or a year ends at some moment, and a test that reads the clock runs across that moment some of the time. Use the seam of the layer under test:

| Layer | Seam |
|---|---|
| Vitest | `vi.useFakeTimers({ now })`, `vi.setSystemTime`, `vi.advanceTimersByTimeAsync`; or a clock passed in, as the bench sampler takes `clock` |
| A Playwright page | `page.clock.setFixedTime(t)` freezes `Date` and keeps timers running; `page.clock.setSystemTime(t)` moves `Date` and lets it run on; `page.clock.install` only when the page's timers must be driven too |
| The mock backend | its clock is real time plus `advanceMs`, read with `stats().now`; set it a known distance into a bar with `advanceMs`, and `resetClock` in `afterEach` |
| A server render | reads real time, which no test controls: derive expectations from what the page carries (the served range, the seeded coverage), never from the test's clock |

When an assertion depends on which bar or day "now" falls in, pin it. The pattern from fix 31: hold the event back (`page.route` on the stream), set the page's clock in the bar the test needs, then release the event, so the boundary passes on every run, not one run in a hundred.

The same applies to the code under test. A range that a page reads up to now ends at the start of the bar forming now, not at now itself: the cache snaps an end between grid points outward to the next one (architecture §8, N1), a bar that cannot exist yet, and a read crossing a minute boundary then fetches a bar more than expected. `formingBar` in `reference/shared/src/market.ts` gives that start.

## Timing

The correctness suite never asserts on elapsed time or on a ratio of timings. Both depend on the machine and on what else runs on it. Timing belongs to the bench (`docs/benchmarking.md`), which pairs the two revisions in one process, checks itself with an A/A control and reports until it is calibrated.

Logic that works with time, such as the sampler, takes a clock, and its tests pass one that their operations advance (`packages/tscache/test/perf/gate.test.ts`), so the results are exact.

Elapsed time may bound something from above, because a slow machine only lengthens it: the polling spec bounds the number of polls by the time it waited. Such a line carries `clock-ok`.

## Waiting

A test never sleeps for an effect to happen. A sleep long enough on an idle machine is too short on a busy one. Wait for the effect itself:

- Await the promise that carries it, when there is one.
- Otherwise wait for its condition: `vi.waitFor(assertion, { timeout: 4000, interval: 1 })` in Vitest, `expect.poll` and Playwright's auto-waiting assertions in a spec. These fail only at their timeout, which is there to catch a hang.
- Messages on one port arrive in order. A round trip on the same port is a barrier: after its answer, everything the other side sent before has arrived (`barrier` in `orchestrator.test.ts`).
- A scenario that needs something slow, such as a module that takes a while to import, gets a gate the test opens (`gatedModule`), not a timer.

To prove that something does *not* happen, prefer a later, ordered event that would come after it: an exact check of the later event's payload, or a barrier. When only a pause can show it, keep the pause short and mark it `// clock-ok: an absence check`. A slow machine can make such a check pass wrongly; it cannot make it fail.

Never race an operation against a timer to prove it answers promptly. Await it: an operation that waits for something the test never releases fails at the test's timeout, on any machine.

Timeouts detect hangs. They are never an assertion of speed, and raising one never fixes a flake.

## Shared state

Each app of the examples project has one mock backend and one server process for all its tests, and its spec runs serially (`test.describe.configure({ mode: "serial" })`). A test that changes the backend (its clock, failures, latency, the dataset version) undoes it in `afterEach` or before it ends. A test that needs a precondition sets it up itself: the server-rendered tests first have the server render once (`serverReadsCurrentVersion`), because its in-process cache outlives tests and a test may have restated the data.

`--repeat-each` makes copies of a serial group that run side by side on different workers, against the same backend. Repeat with `--workers 1`, as `scripts/flake-hunt.sh` does.

Playwright's web servers listen on fixed ports and, outside CI, reuse a server already running. Two checkouts must not run Playwright at the same time.

## Retries

Playwright retries stay at 0 and Vitest has none, so a flake fails the run it happens in. A retry turns a flake into a pass that hides it.

## Finding flakes

`scripts/flake-hunt.sh` runs test files many times: each Vitest run in a fresh process, as CI runs them, and each Playwright test with `--repeat-each`, one worker and no retries. `--load` keeps every core busy meanwhile. Without files it takes the test files the branch changed since `main` (or `--base`); `--all` takes every test file. It checks every input before running anything and fails on a bad one, and it fails a hunt that executed no test, so a typo cannot pass as a clean result.

```bash
scripts/flake-hunt.sh -n 20 --load packages/tscache/test/orchestrator.test.ts
bun run build && scripts/flake-hunt.sh -n 5 --load e2e/reference/clients.spec.ts
scripts/flake-hunt.sh -n 10            # the test files changed since main
```

On the shared development machine it is a heavy job: one at a time.

The `Flake hunt` workflow (`.github/workflows/flake-hunt.yml`) runs the same script on GitHub: dispatch it on a branch to hunt in the files it changed or in named files, and it runs every test five times under load each week. It is not a required check.

A flake found is reproduced first, deterministically: a pinned clock, a held event or a gate makes it fail on every run. Then the cause is fixed and the reproduction stays as the regression test. The step's review file records the flake, its cause and the before and after counts.
