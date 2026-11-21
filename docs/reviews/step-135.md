# Step 135 — M5 deploy skew

Branch: `feat/135-m5-deploy-skew` · Reviewers: none yet (the director starts the rounds) · Status: built, verified by the implementer, awaiting review · Merge: by the user (the step touches the public API, the architecture and locked decisions)

## Scope

Builds finding M5 of the review of 2026-11-10, as designed in `docs/design/m5-deploy-skew.md` (step 100, reconciled in step 127) and decided by the user on 2026-11-16 (decision 71). Phase A (Codex) wrote the contract tests for `persist/` and `orchestrator/`; this is phase B.

- **Architecture.** The approved text moved into `docs/architecture.md`: §2.1 (`client.superseded`, `WorkerFeature`, `clearAll`'s reach), §2.6 (`ConfigError.code`), §2.7 (the event, the new `persistStopped` reason, a new "Deploy skew" block), §3.1–§3.2 (the `features` example, the event envelope, the refusal's code, why the protocol stays 1), §4 (the module layout), §4.7 (the server's new calls, `PortClient.lib`, the channel's messages and rules), §4.8 (the generation key, the property, `hello.lib`), §4.9 (the refusal's code), §4.10.1 and §4.10.6–§4.10.9 (superseding, the relay, the wiring, the interaction rows) and §8. Rows F1–F16 are decisions N125–N140 and the refusal's code is N141, one file each under `docs/decisions/`. N52, N54 and N66 carry the dated notes decision 71 approved. The proposal is marked as built, and the roadmap's sketch and `docs/INDEX.md` say so.
- **Persistence** (`persist/`, strict test-first). `Persister.supersede()`, `HostedPersistence.supersede()`, and the posting of `clearAll` by `HostedPersistence` and `ClearOnlyPersistence` through `ClearPosts` (`persist/clear-posts.ts`).
- **Orchestrator and errors.** `ConfigError.code`, `ConfigErrorCode`, and the refusal thrown with `'fetcher-conflict'`.
- **RPC.** `rpc/workers-channel.ts` (the `BroadcastChannel` and the post of the hostings that only post), `rpc/generations.ts` (announce and present, the rank, the same-generation rule), `RpcServer.supersede()` and `RpcServer.channelClear()`, the server's feature list from its entry, `PortClient.lib` and `PortClient.superseded`, and the client's rebuilder of the refusal's code.
- **Client and entries.** The SharedWorker's `name`, `client.superseded` and the `superseded` event, the two development messages, and the worker entry and the in-process hosting wired to the channel.
- **Tests.** Spec tests 11–17, 29–32 and 36 in Vitest, 18–24, 33 and 34 in Playwright, and the e2e server's second generation of fixtures.
- **Bench.** No new case. Three size budgets raised (below).
- **Docs.** `site/guides/workers.md` ("Stale scripts after a deploy" rewritten), `site/usage/client.md`, `site/usage/errors.md`, `site/troubleshooting.md`, `site/guides/persistence.md`, `site/concepts/events.md`, `site/guides/patterns.md`, `site/guides/vite.md`, `site/index.md`, the four `site/how-it-works/` pages that describe how a SharedWorker is created, the regenerated `site/how-it-works/package-map.md`, `docs/guides/patterns.md`, `docs/guides/worker-setup.md`, `docs/testing.md`, `docs/benchmarking.md` and `docs/releases/0.3.0.md`.
- **Not changed here.** `docs/review-checklist.md` (a protected path; see Decision concerns), the changelog, the package version, and `docs/releases/0.2.0.md`, which describes that release.

`origin/main` moved once during the step (step 128, `facf39fe`) and was merged in `face920a`; `bun.lock` did not change.

## Decisions applied

User decision 71 (2026-11-16), each row as the brief lists it:

| Row                    | Option                                                  | Decision | Where built                                                                             |
| ---------------------- | ------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| F1                     | (a), with the amendment of §4.8 and §4.10.8             | N125     | `client/hosting.ts` (`generationKey`, the `name` option)                                |
| F2                     | (a)                                                     | N126     | `client/hosting.ts`                                                                     |
| F3                     | (a)                                                     | N127     | `rpc/workers-channel.ts`, `rpc/generations.ts`, `entries/worker.ts`                     |
| F4                     | (a)                                                     | N128     | `rpc/generations.ts` (`outranks`)                                                       |
| F5                     | (a), with the amendment of N52 and §4.10.7              | N129     | `persist/persister.ts`, `persist/hosted.ts` (`supersede`)                               |
| F6                     | (a)                                                     | N130     | `rpc/generations.ts` (superseded once), `persist/persister.ts` (the reason is kept)     |
| F7                     | (a)                                                     | N131     | `types.ts` (`persistStopped.reason`)                                                    |
| F8                     | (a)                                                     | N132     | `rpc/server.ts` (`supersede`), `client/client.ts`, `types.ts`                           |
| F9                     | (a)                                                     | N133     | `rpc/generations.ts` (only the lower-ranked worker acts)                                |
| F10                    | (a)                                                     | N134     | nothing reloads; `site/guides/workers.md` recommends a prompt                           |
| F11                    | (b), the relay, with the amendment of N54, N66, §4.10.7 | N135     | `persist/clear-posts.ts`, `persist/hosted.ts`, `persist/clear-only.ts`, `rpc/server.ts` |
| F12                    | (a)                                                     | N136     | `rpc/port-client.ts` (`lib`), `client/client.ts`, `client/dev.ts`                       |
| F13                    | (a)                                                     | N137     | no code; the guides' advice                                                             |
| F14                    | (a)                                                     | N138     | `entries/worker.ts`, `client/in-process.ts` (a post, no listener)                       |
| F15                    | (a)                                                     | N139     | see Decision concerns                                                                   |
| F16                    | (a)                                                     | N140     | `rpc/generations.ts` (`sameGeneration`, the development warning)                        |
| The refusal's identity | `ConfigError.code` `'fetcher-conflict'`                 | N141     | `errors.ts`, `orchestrator/orchestrator.ts`, `rpc/protocol.ts`                          |

**The four decision concerns** of the proposal's §8 (user items #101–#104) were open while this was built. Each is built with its recommended option, in commits of its own, so that another answer is a contained change:

| Concern | Built as                                                                                                                                                                                                                         | Commits                                                    | What another answer needs                                                                                                                                                                                                 |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DC1     | (a): every message a worker acts on clears and sends both events. A dated note on N84, a sentence in architecture §2.7 and one in `site/concepts/events.md` say a relayed `clearAll` counts as k + 1 calls. No code              | `20670233`                                                 | Revert it; (b) to (d) change the events or the receiver rule, and browser test 34's count of two events per tab                                                                                                           |
| DC2     | (a): only a SharedWorker that has opened the workers' channel lists `'superseded'`; no development warning for a listener without it. Test 29                                                                                    | `bc8070fc` (code, test, architecture), `9014dc2c` (guides) | Before `bc8070fc` no worker lists the name, which is none of the options: (b) is `HELLO_FEATURES` gaining the name; (c) adds N80's warning to (a). Three browser and Vitest assertions on `features` follow               |
| DC3     | (a): dated notes on N87, N88 and N103; architecture §2.9, the TSDoc of `memoryBudget` and `memoryStats`, `site/guides/workers.md`, `site/guides/patterns.md`, `site/usage/client.md` and the 0.3.0 notes corrected. No behaviour | `5d81a728`                                                 | Revert it; (b) keeps the corrections outside `docs/decisions/`                                                                                                                                                            |
| DC4     | (a): the port client keeps the first `superseded` event; `client.superseded` is set when `createClient` resolves; the event follows on the next macrotask, after the `modeFallback` steps. Test 30, in both arrival orders       | `61ee9202` (code, test, architecture), `ddbc781c` (guides) | Revert both: the event is then delivered live only, and a client created with a `memoryBudget` against a worker already superseded never gets it (the gap DC4 describes). (b) needs the kept payload without the delivery |

## Choices made without a decision row

Codex's three open points, each taken as the option that fits the proposal and the existing code, and each tested in `packages/tscache/test/persist-supersede-choices.test.ts`:

- **A cleanup queued by an earlier per-cache failure when `supersede()` runs.** It is dropped, and one that is running is abandoned; the `durable` waiters of those caches are released, as a settled cleanup releases them. A cleanup deletes every record of its cache, and after the stop those records may be the current generation's: §4.4 of the proposal says the superseded worker writes nothing more and that "the records belong to the current generation now". The cost is the one §4.4 already accepts for a removal released by the stop: what the old worker's memory had withdrawn can stay on disk, and the current generation's engine never held that memory.
- **How long seen clear ids are kept.** The 64 seen last, own ones included. Forgetting an id costs at most one more relay post for it, and an id is forgotten only after 64 other `clearAll` calls reached the hosting, so repeated posts cannot sustain themselves: each would need that many new calls by the application. A count, not a time: the library's persistence has no timer that is not a deadline or a debounce.
- **A `post` callback that throws.** Ignored, at the start and at the settling. A logout on this worker must neither fail nor wait because the channel did; other workers then miss that post.

Further choices:

- **`Announce.name`.** The proposal's sketch of the channel message has no such field. F16 (a) has each worker warn "naming the two keys", and the resolved `fetcher` alone cannot give a key back, so the message carries the SharedWorker's name. It is optional, and a message without it compares as before.
- **Before its own `announce` a worker neither answers nor compares.** It does not know its fetcher yet, so a `present` from it would name none and could be taken for the same generation. Its own `announce` brings a `present` from every worker running then, so nothing is missed. It still acts on `clearAll` messages from the moment it subscribes, as the relay's proof needs.
- **A superseded worker still answers `announce`.** The proposal ranks by message alone, so a newcomer ranked below a superseded worker is superseded too, although that worker no longer writes. See Decision concerns.
- **The `fromClearId` argument on `ClearOnlyPersistence`.** Codex's tests fix it (the "clear-only receiver seam" of its report), and it shares `ClearPosts` with the hosted persistence. No entry calls it with an id: under F14 (a) the dedicated-worker and in-process hostings do not listen.
- **Where the refusal's `code` lives.** `declare readonly code?`, so a `ConfigError` without a code has no own `code` property: its shape is what 0.2.0's was.
- **The development warning of F16 prints in the worker's console**, as the proposal says ("a development build of each worker"). A worker served as the unbundled `dist/` has no `process`, so it counts as production and stays silent, as the page's messages do.
- **`superseded` with a malformed payload.** The client takes `lib` when it is a string and an empty string otherwise, rather than dropping an event that says the tab is stale.
- **Tests run without Node's real `BroadcastChannel`.** It spans every thread of a process, so the worker entry under test would join the workers of other test files. `packages/tscache/test/setup-channel.ts` removes it for this package's files; tests of the channel install the fake of `test/workers-channel.ts`, whose delivery is synchronous or held. `docs/testing.md` records it under Shared state.
- **Three size budgets, not eight.** `index`, `index:lazy` and `worker` grew past their budgets and were raised by the repository's rule; the persistence chunk and the engine grew by 0.09 and 0.01 kB and keep theirs, as `fetcher` and `vite` do, so no unrelated gate loosens.
- **The worker entry's exports are unchanged.** `createServer` gained a fifth, optional argument for tests and for the entry itself; its type is not exported.

## Contract-test changes

Codex's three files (`packages/tscache/test/persister-supersede.test.ts`, `persist-deploy-skew.test.ts`, `orchestrator-deploy-skew.test.ts`; 57 cases) landed unchanged with the code that makes them pass (`fed8b41c`). No assertion and no line of them was edited.

One wiring edit outside them, in the shared helper `packages/tscache/test/persist-harness.ts`: the two local unions of `persistStopped`'s `reason` gain `'superseded'`. Without it the harness's `onStopped` no longer type-checks against `PersisterOptions`, whose event type gained the member.

No contract test looked wrong against the proposal.

## Other test changes

- `packages/tscache/test/client.test.ts`, "creates the SharedWorker as a module with extendedLifetime…": the exact expected constructor options gain `name: 'tscache:<LIB_VERSION>:'`, which F1 (a) adds. Still an exact `toEqual` for both tabs; the test is spec test 13's first half.
- `packages/tscache/test/dev-warnings.test.ts` and `m3-memory-client.test.ts`: their fake servers reported the library version `"0.0.0"`, which now draws F12's development warning and so changed their exact `console.warn` counts. They report `LIB_VERSION`; every assertion is unchanged.
- `integrations/test/helpers.ts` (`lossy()`) and `integrations/test/react.test.ts` (`losable()`): the client doubles gain `superseded`, forwarded from the client they wrap (`TscacheClient` requires it).

## New tests

| Spec test (§6)                                         | Where                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1–6, 25–27, 28 (barrier)                               | `persister-supersede.test.ts` (Codex)                                                                                                        |
| 7–10, 28 (relay)                                       | `persist-deploy-skew.test.ts` (Codex)                                                                                                        |
| 35                                                     | `orchestrator-deploy-skew.test.ts` (Codex)                                                                                                   |
| 11, 12 (seeded properties), 14, the posting half of 16 | `generations.test.ts`                                                                                                                        |
| 13, 15, 16, 17, 31, 32, 36                             | `deploy-skew-rpc.test.ts`; 13's first half also in `client.test.ts`                                                                          |
| 29 (DC2)                                               | `deploy-skew-features.test.ts`                                                                                                               |
| 30 (DC4)                                               | `deploy-skew-late-event.test.ts`                                                                                                             |
| The entry among the workers of its origin              | `deploy-skew-entry.test.ts`                                                                                                                  |
| Codex's three open points                              | `persist-supersede-choices.test.ts`                                                                                                          |
| 18–24, 33, 34                                          | `e2e/deploy-skew.spec.ts`, with `scripts/e2e-server.ts` serving `/fetcher-b.js`, `/backend/<ns>/fetcher.js` and the package as `/dist-next/` |

Test 22's last clause, "the messages-per-read budget is unchanged", is the existing counted budget in `packages/tscache/test/perf/`, which passes unchanged. Tests 20 and 21 read the store itself (`storedPages` and `stored` in `e2e/support.ts`) and never rely on a reload.

Each new Vitest test of the behaviour was checked against a mutant where that was cheap: without `#dropCleanups` the two cleanup tests fail, and without the client's use of the kept event four of test 30's seven cases fail.

## Decision concerns

For the user. None of them is acted on beyond what is said.

1. **F15 and the release.** F15 (a), now N139, says M5 ships in its own minor release. `docs/releases/0.3.0.md` already carries M3, and the brief says the calendar grid too; the brief asked for M5 to be added there, which this step did. The notes therefore describe one release with three designs, the option F15 (b) the user did not take. Options: (a) keep 0.3.0 as the notes now are, and record that N139 was overtaken; (b) cut M3 as 0.3.0 and move the M5 paragraphs to a 0.4.0 file. Recommendation: the user's call when the release is cut; nothing in the code depends on it.
2. **DC1–DC4** are built with their recommended options (above). They stay the user's to answer.
3. **`docs/review-checklist.md` §12** is a protected path and is not edited. Its item "Two engines writing one database" describes the overlap before F5 (a) and F11 (b). It should say that a superseded worker stops writing, and that a `clearAll` is relayed to every SharedWorker. The user owns that file.
4. **A newcomer ranked below a superseded worker.** Worker A (0.3.0) is superseded by B (0.4.0); B's tabs close, A's stay; a rolled-back tab C (0.2.x with this design, or any generation ranked below A) then starts. A answers C's `announce`, C finds A higher-ranked and is superseded, and nobody persists until A or C ends, although neither writes. The proposal's rule ranks by message alone (§4.3) and F6 (a) keeps A superseded, so this is the design as approved; §4.9's rollback paragraph describes the two-worker case only. Options: (a) as built; (b) a superseded worker stops answering `announce` and is not compared against, so C stays current and persists, which changes §4.3's unconditional answer. Recommendation: (a) for now; it needs three generations and costs persistence, never data.
5. **Decision numbers.** N125–N141 are taken here. The brief warns that step 129 (the calendar grid) may number its decisions from N125 on its own branch. Whichever merges second has to renumber; this step did not touch that branch.
6. **`docs/INDEX.md`'s `docs/design/` row on `main`** lost the words step 127 gave it ("reconciled with M7 and M3 as built in step 127, which lists four decision concerns in its §8") when step 128 merged. This step's row says "built in step 135" and does not restore them.

## Verification

Run by the implementer on this machine (macOS, Bun, Node 22 under nvm), heavy jobs through `~/code/tscache-reports/bin/heavy-run.sh`. The full run below is on `cee682e3`; the two commits after it are `8e3a8adc`, which only regroups the e2e server's routes (Fallow warned of its request handler; the two specs that load the server passed again), and the commit of this file. The implementer's report gives the result of `bun run ci` on the final head.

| Check                           | Command                                                                                                                              | Result                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex's contract tests          | `bunx vitest run packages/tscache/test/persister-supersede.test.ts …/persist-deploy-skew.test.ts …/orchestrator-deploy-skew.test.ts` | 57 passed (50 failed and 7 passed before the code)                                                                                               |
| Everything `bun run ci` runs    | `heavy-run.sh "135 child: ci" bun run ci`                                                                                            | exit 0 on `cee682e3`: Vitest 165 files, 3,189 tests; Playwright 203 passed; `test-clocks` 207 files clean; Fallow health 96 (floor 95); sizes ok |
| The clock rules                 | `bun scripts/test-clocks.ts`                                                                                                         | 207 files clean; no `clock-ok` line added                                                                                                        |
| The new Vitest files under load | `heavy-run.sh … scripts/flake-hunt.sh -n 20 --load` over the nine new test files                                                     | 0 failures in 20 runs, 2,620 tests                                                                                                               |
| The browser spec under load     | `heavy-run.sh … scripts/flake-hunt.sh -n 10 --load e2e/deploy-skew.spec.ts`                                                          | 100 passed, each test 10 times on one worker                                                                                                     |
| The core Playwright project     | `heavy-run.sh … bunx playwright test --project=chromium`                                                                             | 51 passed, the 41 older specs with named workers included                                                                                        |
| After `8e3a8adc`                | `bun run fallow`; `heavy-run.sh … bunx playwright test --project=chromium e2e/deploy-skew.spec.ts e2e/client.spec.ts`                | Fallow: no issues in 93 changed files; 17 passed                                                                                                 |
| Bench against `main`            | `heavy-run.sh "135 child: bench" bun run bench`                                                                                      | exit 0; no gated case fails (below)                                                                                                              |

Not verified: Firefox and Safari (the suite runs Chromium only, as before); a real deploy with a bundler other than the e2e server's unbundled `dist/`; and the development warning of F16 in a real worker console, which is covered under Vitest only. The first `bun run ci` attempt after this file was drafted failed in `biome ci` on this file's own table alignment, before it was committed; nothing else was run in that attempt.

## Sizes and bench

`bun scripts/size.ts`, brotli, `main` at `09627a7c` (measured in a temporary worktree) against this branch:

| Entry                  |   Before |    After | Budget before | Budget after |
| ---------------------- | -------: | -------: | ------------: | -----------: |
| `index`                |  5.31 kB |  5.77 kB |          5952 |         6432 |
| `index (lazy)`         | 14.25 kB | 14.77 kB |         15104 |        15648 |
| `index (lazy, nested)` |  5.39 kB |  5.48 kB |          6000 |         6000 |
| `worker`               | 15.50 kB | 17.00 kB |         16352 |        17936 |
| `worker (lazy)`        |  5.39 kB |  5.48 kB |          5824 |         5824 |
| `engine`               | 11.57 kB | 11.58 kB |         12352 |        12352 |
| `fetcher`              |  0.17 kB |  0.17 kB |           656 |          656 |
| `vite`                 |  1.24 kB |  1.24 kB |          1488 |         1488 |

The three raised budgets are the new size plus max(512 B, 3 %), the repository's rule (`312dc2f7`). The page pays 0.46 kB for the property, the event, the generation name, the kept event and two development messages; the worker 1.50 kB for the channel, the rank, the relay and the server's two calls. The measurement tree-shakes, so moving the post-only channel code into `rpc/workers-channel.ts` (`e97ee82c`) changes the built chunks, not these figures.

The counted budgets of `packages/tscache/test/perf/` (messages per read, memory, fetches, extents, growth) pass unchanged: nothing is added per operation or per message on the port.

`bun run bench` (`bun scripts/bench.ts compare`), `cee682e3e` against `facf39fea` (`origin/main`), exit 0. In the Bun runtime the A/A control left its bounds on this run (1.019 in [1.000, 1.050]), so the tool marked the runtime noisy and failed nothing; every case was `ok` in both runtimes:

| Case                     | Bun, head/base (95 % CI) | Chromium, head/base (95 % CI) |
| ------------------------ | ------------------------ | ----------------------------- |
| `read-viewport`          | 0.961 (0.951–0.999)      | 0.996 (0.992–1.004)           |
| `read-viewport-sessions` | 0.961 (0.956–0.992)      | 0.995 (0.990–0.997)           |
| `read-viewport-budget`   | 0.957 (0.953–0.982)      | 1.001 (0.998–1.005)           |
| `read-year`              | 0.969 (0.927–0.983)      | 0.992 (0.989–0.997)           |
| `put-page`               | 0.999 (0.992–1.004)      | 0.999 (0.995–1.001)           |
| `put-page-budget`        | 0.998 (0.994–1.004)      | 0.974 (0.973–0.977)           |
| `put-live-bar`           | 0.991 (0.988–0.997)      | 0.998 (0.997–0.999)           |
| `append-bars`            | 1.023 (1.017–1.028)      | 1.001 (1.000–1.004)           |
| `fill-month`             | 0.997 (0.995–1.002)      | 0.981 (0.978–0.987)           |
| `snapshot-roundtrip`     | 0.988 (0.965–1.038)      | 0.968 (0.960–0.971)           |
| `read-transfer`          | 1.000 (0.985–1.008)      | 1.004 (0.981–1.013)           |

`append-bars` reads 2.3 % slower in Bun on a run the tool itself calls noisy, and 0.1 % in Chromium; the step changes nothing on the put path, and the gate did not fail it.
