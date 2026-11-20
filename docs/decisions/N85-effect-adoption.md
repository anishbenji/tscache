# N85: Effect is not adopted

Row N85 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. Recorded in step 115. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary. This file began as an architecture decision record written on 2026-11-15 and kept outside version control until this step; it moved here unchanged except for the title, the resolution and status, the decisions (which replace its open questions), the guardrail and adoption-step status, the heading of its consequences, one word of the `AGENTS.md` line ("the ADR lists which" became "the decision lists which"), three sentences dated to the evaluation where step 111 has since closed the test gap it found, and its own path. Its analysis, measurements, sources, review record and appendix are kept as written.

## Resolution

**Effect (`effect`, `@effect/*`) is not adopted in this repository, in any layer, and no pilot is run;** two cheaper guardrails are taken instead: Biome's four type-aware promise rules as errors, with `noImplicitReturns`, and one line in `AGENTS.md` that records this decision. Why: the package is a published library, used mainly in the browser, with no runtime dependencies and a size budget on every entry, and one small module ported to Effect 4.1.4 added 13.8 kB brotli to its chunk; the typed error channel Effect would bring is a small gain here, and the measured port showed that neither the type checker nor the tests then in place guarded the ordering and deadline rules that make the code hard (see "Measurements" and "Decision for each layer"). Reopen only under one of the four conditions in "When to revisit". User decision 75: question 1 on 2026-11-15, questions 2 to 6 on 2026-11-16 (see "Decisions").

- **Status:** decided, 2026-11-16.
- **Decision owner:** the user.
- **Scope:** whether this repository should adopt Effect (`effect`, effect.website), and in which layers.

## Decisions

The user's answers to the six questions the record put (user decision 75):

1. **Adopt Effect now?** No (2026-11-15: "Let's not adopt it now"). No pilot was requested, so none is run and `effect` is not added as a dependency. If a pilot is wanted later, the candidate is still the demo launcher (`scripts/demo.ts`, `scripts/demo/processes.ts`), on a `chore/effect-spike` branch.
2. **Where the record lives:** `docs/decisions/`, by the repository's convention, under the next free number with a line in architecture §8 and a `docs/INDEX.md` entry (2026-11-16). The record suggested N71; step 114 takes N71 to N84, so this is N85.
3. **Biome's four nursery promise rules as errors:** approved (2026-11-16); step 116 applies them.
4. **`noImplicitReturns`:** approved (2026-11-16); step 116 applies it, on the same branch as the Biome rules.
5. **The `AGENTS.md` line:** approved as worded under "Guardrails", with its path pointing at this file (2026-11-16); step 117 applies it.
6. **Revisit conditions:** the four under "When to revisit" are kept as written (2026-11-16).

## Summary

**Recommendation: do not adopt Effect in this repository now.** Effect is a sound choice for a TypeScript application or back end, which is the case Matt Pocock described. This repository is a published library, used mainly in the browser, with no runtime dependencies and a size budget on every entry. One small module ported to Effect is about 14.6 kB (brotli) against 294 B today, and it adds 13.8 kB to the chunk it ships in; the entry budgets run from 0.7 kB to 13.7 kB.

Effect's main guardrail is a typed error channel. The public API already has the equivalent: expected failures are status values, and programmer errors are typed classes. Inside the library, failures at the few I/O boundaries are untyped, and Effect would type them. That gain is real but small here, because each boundary treats every failure the same way by design.

Two cheaper guardrails are worth taking instead. Both report nothing on the code today, so they cost no migration:

1. Turn on Biome's four type-aware promise rules as errors.
2. Add one line to `AGENTS.md` that records this decision, so that no agent introduces Effect without new facts and the user's approval.

Revisit the decision if the project gains a server-side package (see "When to revisit"). If a trial is wanted before then, the demo launcher's process management is the best candidate (see the last row of "Decision for each layer").

## Context

### Why this was asked

In his Software Factories office hours of 2026-11-13, Matt Pocock said that he likes Effect for building TypeScript applications, back ends especially, because its API and lint rules are strict enough that coding agents find it hard to get things wrong. This repository is built almost entirely by agents, so the question is whether that benefit applies here. I did not verify the quotation; it is taken from the request.

### What the repository is

- **What it does.** `@anishbenji/tscache` (0.1.0, released 2026-11-13) caches timestamp-aligned time-series data in the browser. It tracks coverage (what is known) apart from data (what exists), so that a confirmed gap is not fetched again.
- **Where it runs.** Mainly in the browser: one engine class runs in a SharedWorker, a dedicated Worker or in the page, with clients in each tab that talk to it over a `MessagePort`. The `./engine` entry and the in-process client also run in Node and Bun, for server rendering and tests (package README, "Entries"; `site/guides/ssr.md`). One entry, `./vite`, runs in Vite's Node process. The scripts, benchmarks and the mock backend run on Bun; Vitest runs on Node.
- **Size.** 49 source files and 9,517 lines in `packages/tscache/src`; 27,644 lines of tests.
- **Dependencies.** The package has no `dependencies`. Its only peer is Vite, and that is optional. It is ESM-only (decision 6).
- **Size budgets.** `scripts/size.ts` fails CI when an entry exceeds its brotli budget in `packages/tscache/bench/budgets.json`: `index` 5,008 B, `worker` 13,728 B, `engine` 10,272 B, `fetcher` 656 B, `vite` 1,488 B, and 12,976 B, 6,000 B and 5,824 B for the three lazily loaded parts.
- **Errors today.** Programmer errors throw or reject with a subclass of `TscacheError` (`src/errors.ts`, architecture §2.6). Expected data and storage failures do not reject: a read reports a status per range, and persistence stops a cache with `'unavailable'` or `'error'` (N59: "Never a rejected call"). One failure rejects without being a programmer error: when the transport is lost (a worker that died) or the client is disposed, pending calls reject with a `TscacheError` (`src/rpc/port-client.ts`). An authentication failure from the consumer's fetcher is detected by a marker on the error, not by `instanceof`, because the fetcher is a separate bundle (N8). Inside the library, promise rejections carry no type: `PersistStore.write`, for example, returns `Promise<void>`, and the persister treats any rejection as a failed attempt.
- **Retries and deadlines today.** Hand-written, in `src/persist/`: a failed write is retried after `debounceMs` under one deadline per job (N59, N61). These rules are locked decisions with contract tests.
- **Async and concurrency today.** Promises on a single thread. Concurrency between tabs is handled with message ports, Web Locks and an in-flight list that deduplicates fetches (N31, N62).
- **Validation today.** Hand-written checks that throw `ConfigError` or `PutError` naming the first offending value (`src/engine/validate.ts`, `src/engine/batch.ts`).
- **Type and lint settings.** TypeScript 7.0.2 (the native compiler) with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`, `verbatimModuleSyntax` and `isolatedDeclarations`. Biome 2.6.4 with the recommended preset. Knip, Fallow, publint and attw run in CI.
- **Other guardrails for agents.** Contract tests written by a second model before the implementation, a cross-model review loop, property tests, mutation testing, a benchmark gate, and the size budgets.

### Effect's current state (checked 2026-11-15)

Each claim below names its source; the full list is under "Sources".

- **Effect 4 has shipped.** npm published `effect@4.0.0` on 2026-10-01. `latest` is 4.1.4 (2026-11-11), after 13 stable releases in six weeks. The 3.x line is tagged `prev` at 3.22.4 [S1]. The 4.0 beta began on 2026-02-18 [S1]. The betas were released from the `Effect-TS/effect-smol` repository (seen in a GitHub release listing through a search index, a secondary source); the published package now names `Effect-TS/effect` as its repository [S1], so "effect-smol" has shipped as Effect 4.
- **Stability.** Effect 4 marks each API `stable`, `unstable` or `experimental`. Unstable APIs may break in a minor release. Eighteen module groups are unstable, among them `http`, `http-api`, `rpc`, `schema`, `workers`, `persistence` and `sql`, and so is every package other than `effect` itself, which includes `@effect/platform-browser` [S3]. In 4.1.4, `Schema.d.ts` carries 472 `stable` tags, 192 `unstable` and 46 `experimental` (counted in the installed package). The official 4.0 post describes long-term support for 4.x [S2].
- **Size, official.** "A minimal Effect program bundles to 7.1 kB (minified + gzipped)", against 35.6 kB in 3.x [S2, S3]. My measurement of a minimal program agrees: 8.0 kB gzip (Rolldown).
- **Dependencies.** `effect@4.1.4` has no dependencies of its own [S1].
- **Platform support.** The core has no dependencies [S1] and ran on Bun and Node in my measurements. `@effect/platform-browser@4.1.4` ships browser modules, including worker layers that accept a `Worker`, a `SharedWorker` or a `MessagePort`, and IndexedDB modules [S6]. All of them are marked unstable. Effect therefore runs where this library runs. Support is not the obstacle; size and fit are.
- **Language service and lint tooling.** `@effect/language-service` is a TypeScript plugin, and its README says: "If you are using TypeScript 7.0 or newer, use `@effect/tsgo` instead" [S5]. `@effect/tsgo@0.69.0` supports TypeScript 7.0.2 [S4]. It delivers its diagnostics in one of three ways: by patching the `tsc` binary inside `node_modules` (`effect-tsgo patch`), by running its own patched compiler (`effect-tsgo tsc`), or through a patched Oxlint [S4]. It offers several dozen diagnostics, such as `floatingEffect`, `missingEffectError` and `globalErrorInEffectFailure` [S4]. There is no Biome plugin (`@effect/biome-plugin` does not exist on npm). `@effect/eslint-plugin` exists (0.3.2) but ESLint is not part of this toolchain.
- **Documentation for agents.** The Effect repository ships `LLMS.md` (19 kB), a guide written for coding agents that points into an `ai-docs/` folder of worked examples [S7]. `effect.website/llms.txt` returned 404 on 2026-11-15. The 4.0 post tells readers to hand the migration guide to a coding agent [S2].
- **Testing.** `@effect/vitest@4.1.4` supports Vitest 5 [S8], which this repository uses, and `effect/testing` has a `TestClock`.

## Measurements

I measured in a scratch directory outside the repository. No dependency was added to the repository and no branch was created, because the verdict is "do not adopt" and adding a dependency needs the user's approval (`AGENTS.md`, Dependencies).

### The slice: `persist/clear-disk.ts`

This module (90 lines, 49 without comments and blank lines) empties the database for hostings that do not persist. It has real retry logic: it opens the store, retries a rejected clear after `debounceMs`, gives up at one deadline, and closes the connection exactly once, also when the database opens after the deadline. It then had 14 tests, on Vitest's fake clock (15 since step 111).

I ported it to Effect 4.1.4 (`Effect.retry`, `Schedule.spaced`, `Effect.timeoutOption`, `Effect.callback`, `Effect.uninterruptibleMask`, `Effect.suspend`, `Effect.ensuring`) and ran the repository's own test file against the port. The final port is in the appendix. Like the original, it treats every failure alike (`unknown`, then ignored), so it does not exercise Effect's typed error channel: this module has no failure to tell apart from another.

|                                                         |    Today | Effect port |
| ------------------------------------------------------- | -------: | ----------: |
| Lines without comments and blanks                       |       49 |          48 |
| The file's 14 tests passing                             |       14 |          14 |
| The late-retry case (below)                             |   passes |      passes |
| Minified                                                |    525 B |    48,000 B |
| Gzip                                                    |    329 B |    15,981 B |
| Brotli                                                  |    294 B |    14,571 B |
| The whole persistence chunk (`persist/lazy.ts`), brotli | 13,935 B |    27,782 B |

Sizes are from Rolldown 1.3.2, the bundler behind the package build, with minification, for the browser. `Bun.build`, which `scripts/size.ts` uses, gives 295 B and 15,098 B brotli for the module. The chunk row bundles `persist/lazy.ts` on its own with everything it imports, once as it is and once with the port in place of `clear-disk.ts`; the budget rows for lazy parts leave out what the entry already holds, so the chunk figures are not comparable with a budget, but their difference is.

Four findings matter more than the line count.

1. **Size.** The port is about 50 times the brotli size of the module it replaces, and it adds 13.8 kB to the persistence chunk, whose lazy-part budgets are 5.8 kB to 13.0 kB. Later modules in the same chunk would share the runtime, so most of that cost is paid once per chunk; I did not measure a second module. Every entry or chunk that is loaded on its own and uses Effect carries its own share.
2. **The port took four attempts. The type checker passed all four, and the repository's tests passed a wrong one.** The first used `Effect.acquireUseRelease` with a timeout, the idiomatic form. It failed 1 test of 14: the acquire step cannot be interrupted, so a call whose database was still opening did not answer at the deadline. The second moved the work to its own fiber and failed 4 tests: the connection was closed shortly after the call answered, not when it answered. The third passed all 14 tests and was still wrong. The cross-model review found that it started a clear at the deadline when a retry's timer ran late; the original checks the clock again after the sleep (`clear-disk.ts:83`). The fourth guards every attempt and passes that case too. Effect's types guard the error channel. They do not guard the ordering and deadline rules that make this module hard.
3. **Fake timers work.** Effect's scheduler ran correctly under `vi.useFakeTimers` in every attempt, so the repository's testing rules (`docs/testing.md`) would not have to change.
4. **A test gap in the repository, found on the way.** On 2026-11-15 no test in `persist-clear-disk.test.ts` covered a retry whose timer runs at or after the deadline; step 111 has since added one (`docs/reviews/step-111.md`). With the post-sleep check reduced from `if (ended || !due()) return;` to `if (ended) return;`, all 14 tests still pass, and a new late-retry test fails. The module was correct; nothing pinned it. The mutation report already scores this file at 86.0 (`docs/benchmarks/mutation.md`).

### Sizes of the alternatives

Each case is the smallest program that does the named job, bundled with Rolldown 1.3.2 and minified. Each was run once to confirm it works.

| Case                                                                             | Minified |     Gzip |   Brotli |
| -------------------------------------------------------------------------------- | -------: | -------: | -------: |
| `Effect.runPromise(Effect.succeed(…))`, the smallest program that runs an effect | 22,491 B |  7,812 B |  7,179 B |
| The same with `Effect.gen` and one yield                                         | 23,131 B |  8,021 B |  7,399 B |
| `resolveCacheConfig` today (hand-written)                                        |  2,315 B |    966 B |    855 B |
| The same checks with Effect `Schema`                                             | 82,277 B | 25,930 B | 23,492 B |
| The same checks with Valibot 1.5.0                                               |  7,680 B |  2,154 B |  1,927 B |
| The same checks with Zod 4.6.7 (`zod/mini`)                                      | 23,117 B |  7,147 B |  6,448 B |
| The same checks with Zod 4.6.7                                                   | 94,156 B | 25,440 B | 22,410 B |
| A typed result with Effect's `Result` module alone                               |  9,614 B |  3,496 B |  3,263 B |
| A typed result with neverthrow 8.2.0                                             |  6,603 B |  1,967 B |  1,802 B |
| A typed result with better-result 3.0.1                                          | 10,212 B |  3,117 B |  2,825 B |

The four schema cases accept and reject the same 20 probe inputs as the hand-written module (among them an empty `fields` object, a slot cap above 2^31 − 1, and an optional key given as `undefined`). They are still partial: none applies the defaults, normalises the alignment offset or writes the error messages the public contract promises. The hand-written module does all of that in fewer bytes than any of them.

The bundler matters for consumers. esbuild 0.28.2 (`--bundle --minify --format=esm --platform=browser`, then `gzip -9`) does not tree-shake Effect as well: the `Effect.gen` program is 31,650 B gzip, the port of `clearDisk` 38,931 B and the `Schema` case 101,109 B. An application that bundles with esbuild would pay figures of that order.

### Cost of entering the runtime

An indicative microbenchmark, median of seven runs of two chained operations, on this Mac, under Bun and Node (not a browser). Every iteration builds an effect and runs it, so the table shows the cost of entering the Effect runtime once. It did not go through the repository's benchmark gate.

| Operation                                            | Bun 1.4.2 | Node 26.13 |
| ---------------------------------------------------- | --------: | ---------: |
| Two plain function calls                             |    3.5 ns |     7.4 ns |
| `Effect.runSync` of two chained effects              |     88 ns |     191 ns |
| `Effect.runSync` of a generator with two yields      |    239 ns |     650 ns |
| An `async` function with two awaits                  |     61 ns |     110 ns |
| `Effect.runPromise` of a generator with two promises |    521 ns |     954 ns |

This cost is negligible at an I/O boundary, where one entry wraps a database call or a fetch. It would matter only in a design that entered the runtime for every point or every `get`. The engine's loops over typed arrays would stay plain code under any adoption, so the table is not an argument about them.

### What the lighter guardrails report today

- **Biome's type-aware promise rules** (`noFloatingPromises`, `noMisusedPromises`, `useAwaitThenable`, `useExhaustiveSwitchCases`, all in Biome 2.6.4's nursery group): 0 findings across all 786 files Biome checks. I confirmed that `noFloatingPromises` fires on a planted example.
- **`noImplicitReturns`:** 0 new errors across the five type-check projects. (In this checkout `tsc -p .` and `tsc -p e2e` report one `TS2307` with or without the flag, because `node_modules/@examples` is missing: a stale install, unrelated to the flag.)
- **`noPropertyAccessFromIndexSignature`:** 121 errors in the library. Not worth the churn.
- **`erasableSyntaxOnly`:** 3 errors in the library.

## Decision for each layer

| Layer                                                                                          | Verdict                              | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domain logic (`grid.ts`, `coverage.ts`, `segment/`, `engine/`)                                 | Don't adopt                          | Synchronous, pure code over typed arrays: no I/O, no failure to recover from, nothing to schedule. There is nothing here for Effect to model.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| I/O and network (`rpc/`, `orchestrator/`, `client/`, `persist/idb-store.ts`)                   | Don't adopt                          | The I/O is message ports, IndexedDB and a consumer's fetcher whose contract is a `Promise` (architecture §2.5). An adoption could keep the public `Promise` API and would type the internal failures, which are untyped today. The gain is small: each boundary handles every failure alike by design (any store failure is a failed attempt, N59; any fetcher throw except the auth marker is a failed fetch). The cost is the runtime in every entry that uses it: 7.2 kB to 14.6 kB brotli in the measured cases, against budgets of 5.0 kB (`index`) to 13.7 kB (`worker`).                                                                                                                                                                                                                                                                                                                                                                                 |
| Retries and scheduling (`persist/persister.ts`, `clear-disk.ts`, `clear-only.ts`, `hosted.ts`) | Don't adopt                          | The deadline rules are locked decisions (N59, N61) with contract tests, and a port must still satisfy them. The measured port shows that `Schedule` and `timeout` do not express them directly, and that neither the type checker nor the existing tests caught a wrong port. An adoption limited to this layer adds 13.8 kB to the persistence chunk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Configuration                                                                                  | Don't adopt                          | The library reads no environment or file configuration. `CacheConfig` is an argument; see Validation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Validation (`engine/validate.ts`, `engine/batch.ts`, `engine/restore.ts`)                      | Don't adopt                          | `Schema` costs 23.5 kB brotli against 855 B, and the error messages and the first-offender rule are part of the public contract.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Concurrency                                                                                    | Don't adopt                          | The hard concurrency is between tabs and workers, through ports and Web Locks. Effect's fibers model concurrency inside one thread and do not reach across realms.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tests                                                                                          | Don't adopt                          | `@effect/vitest` and `TestClock` help only code written in Effect. The current seams (fake timers, an injected clock, the memory store) already make time deterministic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The edges: `scripts/`, `examples/mock-backend`, `reference/`, the e2e backends                 | Don't adopt now; one pilot candidate | No consumer pays for code here, so size does not count. The strongest case in the repository is the demo launcher: `scripts/demo.ts` polls each app for readiness under a deadline, and `scripts/demo/processes.ts` manages process groups, escalates a shutdown from SIGTERM to SIGKILL and tracks orphans. Scoped resources and cancellation fit that shape. Against it: this is about 380 lines of working, tested developer tooling; the process-group and signal rules are specific to the operating system and would remain; `effect/process` is marked unstable [S3]; and one script in Effect brings a second programming style into the repository and, for the lint benefit, a patched `tsc`. That is not worth doing for its own sake, but it is the right pilot if the user wants one. The mock backend and the reference clients are read by consumers as examples of how to use the library; Effect there would teach Effect and obscure tscache. |

No layer is adopted, so no Effect modules are named for adoption. A pilot on the demo launcher would use `Effect.acquireRelease` and `Scope` for the process groups, `Schedule` for the readiness poll and `Effect.timeout` for its deadline. If the project later gains a server-side package, the modules to evaluate first are `HttpApi` for the routes, `Schema` for request and response validation, `Layer` for wiring, `Schedule` for retries, `Config` for environment configuration and `@effect/vitest` for its tests.

## Lighter alternatives

| Alternative                                 | Verdict         | What it gives                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Biome's type-aware promise rules, as errors | **Adopt**       | They catch an unhandled or misused promise, the most common async mistake, at no runtime cost and in the linter already in use. 0 findings today. Biome infers types itself, less completely than the compiler, and nursery rules may change between Biome versions.                     |
| `noImplicitReturns`                         | Adopt, optional | No code change is needed. A minor gain; the Biome rules matter more.                                                                                                                                                                                                                     |
| `typescript-eslint` `strict-type-checked`   | Don't adopt     | Its peer range is `typescript >=4.8.4 <6.1.0` [S9], so it cannot run against TypeScript 7. It would need a TypeScript 6 alias and ESLint as a second linter. Third-party reports say support waits on a compiler API planned for TypeScript 7.1; I found no primary source for the date. |
| Oxlint with `oxlint-tsgolint`               | Don't adopt now | It is the type-aware linter that works on TypeScript 7 [S10]. It would be a second linter beside Biome for rules that Biome already covers here. Reconsider if a needed rule is missing from Biome.                                                                                      |
| Typed results (neverthrow, better-result)   | Don't adopt     | The public API already returns expected failures as values. Inside the library a result type would type the failures at the I/O boundaries, the same small gain as Effect's, for 1.8 kB to 2.8 kB and a new dependency.                                                                  |
| Valibot or Zod                              | Don't adopt now | The hand-written validation is smaller than either and carries the contract's messages. If the validated surface grows, compare a full implementation (defaults and messages included) before choosing; in the partial cases here Valibot was the smallest library.                      |
| Stricter `tsconfig` flags                   | Already done    | The base config already has the flags that matter. The remaining candidates are measured above.                                                                                                                                                                                          |

## Consequences

**If this proposal is accepted** (it was, 2026-11-15):

- The package keeps no runtime dependencies, and every entry stays inside its budget.
- The public API stays `Promise`-based with `TscacheError` subclasses. Consumers need no knowledge of Effect, and no second copy of a runtime can enter their bundle through this library.
- Deadline and retry code stays hand-written. That code is the hardest in the repository to get right (`persister.ts` is 1,117 lines). Its protection remains the contract tests, property tests and mutation testing, not a library.
- Agents get two new guardrails: a lint error for an unhandled promise, and a written record that Effect was evaluated and declined.

**If Effect were adopted in the library instead** (the rejected option):

- Every entry or chunk that is loaded on its own and uses Effect would carry the runtime. In the measured cases that is 7.2 kB brotli for the smallest program that runs an effect and 14.6 kB once retry, timeout and resource handling are used; these are measurements of single cases, not bounds. The persistence chunk would grow by 13.8 kB. The budget of every entry that took it would have to be raised, and the `fetcher` entry (656 B) could not take it at all.
- `effect` would become a dependency of a library whose users are chart applications. As a regular dependency, an application that uses Effect itself at a version that does not deduplicate would download two copies of the runtime. That is a size cost, not a correctness problem, as long as no Effect value crosses the public API. As a peer dependency it forces an install on applications that do not use Effect.
- The lint benefit would need `@effect/tsgo`, which patches `tsc` in `node_modules` or replaces the `tsc` command, or a patched Oxlint. `tsc --noEmit` is this repository's authoritative type check, so that is a change to the foundation of the gate.
- Human readers would need Effect's vocabulary (fibers, interruption masks, scopes) to review persistence code. The final port in the appendix is no easier to read than the original, and it took a second reviewer to get it right.
- A full adoption would rewrite about 2,800 lines under `persist/` and `orchestrator/`, written against locked decisions over many review rounds, for no change in behaviour. A limited adoption, one boundary behind an unchanged interface, is possible; it then pays the runtime's fixed cost for little use.

## Guardrails

The user approved all three on 2026-11-16 (questions 3 to 5 under "Decisions"). None is applied by the step that records this decision: step 116 (`chore/116-promise-lint-rules`) applies the Biome rules and `noImplicitReturns`, and step 117 (`chore/117-agents-effect-line`) applies the `AGENTS.md` line. Changes to tooling and to agent configuration go on their own `chore/NN-slug` branches (`docs/workflow.md`).

### Line for `AGENTS.md`, under "Toolchain hard rules" (approved; step 117)

```markdown
- **Effect is not used in this repository** (`docs/decisions/N85-effect-adoption.md`, 2026-11-15): one small module ported to it added about 14 kB brotli to its chunk, more than any entry's budget (`packages/tscache/bench/budgets.json`). Do not introduce `effect` or `@effect/*`; propose it to the user only with new facts, and the decision lists which. Every other dependency stays ask-first (Process, Dependencies).
```

### Lint setup: `biome.json` (approved; step 116)

Add a `nursery` group beside the preset:

```json
"linter": {
  "enabled": true,
  "rules": {
    "preset": "recommended",
    "nursery": {
      "noFloatingPromises": "error",
      "noMisusedPromises": "error",
      "useAwaitThenable": "error",
      "useExhaustiveSwitchCases": "error"
    }
  }
}
```

I ran the four rules with `biome lint --only=<rule> .` under the current configuration and found nothing. I did not run `bun run ci` with the edited configuration; the step that lands it must.

### `tsconfig.base.json` (optional in the proposal; approved; step 116)

```json
"noImplicitReturns": true
```

### Language service

None. The Effect language service applies only to Effect code.

## Adoption steps

For the recommended outcome, which the user chose:

1. The user decides this record and its six questions. Done: question 1 on 2026-11-15, questions 2 to 6 on 2026-11-16 (see "Decisions").
2. Step 116 (`chore/116-promise-lint-rules`) adds the Biome rules and `noImplicitReturns`, runs `bun run ci`, and goes through the review loop. Both files control a check, so the user merges it.
3. Step 117 (`chore/117-agents-effect-line`) adds the `AGENTS.md` line, pointing at this file. The user merges it.
4. Step 115 (`docs/115-effect-decision`) moves this record to `docs/decisions/N85-effect-adoption.md`, adds its line to architecture §8 and updates `docs/INDEX.md`.
5. Separately from this decision: step 111 added the late-retry case to `persist-clear-disk.test.ts` (finding 4 under "The slice"; `docs/reviews/step-111.md`).

## When to revisit

Reopen the decision when one of these becomes true:

- The project gains a server-side package or a hosted service, such as a real demo backend. Effect fits that case, and the size budgets do not apply to it.
- Effect's cost falls to a size the entry budgets can absorb. Today the smallest program that runs an effect is 7.2 kB brotli, against an `index` budget of 5.0 kB.
- The library needs a capability that would be costly to write by hand and that Effect provides, such as structured cancellation across many concurrent operations.
- A pilot on the demo launcher, if the user asks for one, shows a clear gain in the code agents write there.

## Risks

- **The hand-written deadline code keeps its complexity.** Declining Effect removes nothing from `persister.ts`. Mitigation: the existing contract, property and mutation tests; and the memory-bounds and change-event designs in `docs/design/` should keep new timing logic small.
- **Nursery rules can change.** A Biome upgrade may rename or re-tune a nursery rule. Mitigation: Biome is upgraded deliberately (a dependency upgrade is a decision), and a renamed rule fails the configuration check loudly.
- **Biome's promise rules can miss cases** that a compiler-backed linter would catch, because Biome infers types itself. They are a floor, not a proof.
- **This analysis will age.** Effect 4 is six weeks old and has released 13 versions. The size and tooling facts here are from 2026-11-15.
- **The measurement is one module.** A different module might port more gracefully. Every case that ran an effect carried 7.2 kB to 14.6 kB of runtime, but I measured no adoption across several modules, so the marginal cost of a second module in the same chunk is unknown. The persistence code is where the retries live, so I judge the sample representative; it is still a sample of one.

## Sources

Primary sources, read on 2026-11-15:

- **[S1]** npm registry, package `effect`: versions, dates, dist-tags, dependencies. https://registry.npmjs.org/effect and https://www.npmjs.com/package/effect
- **[S2]** Effect 4.0 release post. https://effect.website/blog/releases/effect/40
- **[S3]** Effect v3-to-v4 migration guide: size, package consolidation, stability policy, unstable module list. https://github.com/Effect-TS/effect/blob/main/MIGRATION.md
- **[S4]** `@effect/tsgo` README: supported TypeScript versions, patch and wrapper modes, Oxlint, the diagnostics list. https://github.com/Effect-TS/tsgo
- **[S5]** `@effect/language-service` README. https://github.com/Effect-TS/language-service
- **[S6]** `@effect/platform-browser@4.1.4`, package contents (`BrowserWorker.d.ts`, the `IndexedDb*` modules). https://www.npmjs.com/package/@effect/platform-browser
- **[S7]** Effect's guide for coding agents. https://github.com/Effect-TS/effect/blob/main/LLMS.md
- **[S8]** `@effect/vitest@4.1.4`, peer range `vitest >=5.0.0 <6.0.0`. https://www.npmjs.com/package/@effect/vitest
- **[S9]** `typescript-eslint@8.72.2`, peer range `typescript >=4.8.4 <6.1.0`. https://www.npmjs.com/package/typescript-eslint
- **[S10]** `oxlint-tsgolint@7.0.2007`. https://www.npmjs.com/package/oxlint-tsgolint

Secondary sources, used only where marked:

- InfoQ, "Effect 4.0 release" (2026-11), for background on the release; no claim above rests on it alone. https://infoq.com/news/2026/11/effect-4-0-release
- Third-party articles on typescript-eslint and TypeScript 7.1, for the statement that support waits on a 7.1 compiler API. The peer range itself is from [S9].
- Matt Pocock's remark is reported by the user and was not checked against a recording.

Not found: official Effect guidance for authors of published libraries on whether to declare `effect` as a dependency or a peer dependency. The `duplicatePackage` diagnostic [S4] shows that several versions of an Effect package in one program is a known situation; it does not show a failure across a `Promise` boundary, and this document claims none.

All sizes, test results and timings in "Measurements" are my own, made on 2026-11-15 with `effect@4.1.4`, Rolldown 1.3.2, Bun 1.4.2, esbuild 0.28.2 and Vitest 5.1.0.

## Review record

Cross-model review, as the request asked: Codex (high effort, read-only) reviewed the first draft on 2026-11-15 and returned nine findings and three decision concerns, with the verdict "merge after fixes". I checked each against the repository and the scratch measurements; all nine held and are fixed in this text.

| Finding                                                                                          | Disposition                                                                                                                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The port presented as correct started a clear at the deadline when a retry's timer ran late (P1) | Confirmed by a new test. Port fixed (fourth attempt) and re-measured; the text now reports four attempts and the test gap it exposed.                   |
| "Status values" was presented as equivalent to typed error channels (P1)                         | Narrowed: the public API has the equivalent; internal failures are untyped, and a lost transport rejects.                                               |
| "Browser only" was wrong (P1)                                                                    | Corrected: `./engine` and the in-process client run in Node and Bun.                                                                                    |
| Sizes of single cases were stated as bounds (P1)                                                 | Restated as case measurements; the marginal cost on the real persistence chunk is now measured (13.8 kB).                                               |
| The schema cases accepted different inputs (P2)                                                  | The four cases now agree with the hand-written module on 20 probe inputs; re-measured. The recommendation no longer selects Valibot from partial cases. |
| The microbenchmark does not show overhead inside engine loops (P2)                               | The section now says what it measures, and the domain-logic verdict no longer cites it.                                                                 |
| The two `noImplicitReturns` errors were a pre-existing `TS2307` (P2)                             | Corrected: 0 new errors.                                                                                                                                |
| The `duplicatePackage` diagnostic does not show a bundle hazard (P2)                             | Claim removed; duplicate copies are described as a size cost.                                                                                           |
| An `AGENTS.md` change needs its own `chore/NN-slug` branch (P2)                                  | Adoption steps corrected.                                                                                                                               |
| Concern: the rejection of `scripts/` was under-argued                                            | The demo launcher is now assessed concretely and named as the pilot candidate.                                                                          |
| Concern: locked semantics do not require the current implementation                              | Accepted: the text now says a limited adoption is possible and what it costs.                                                                           |
| Concern: the `AGENTS.md` line widened the dependency policy                                      | The line now records the Effect decision only.                                                                                                          |

Codex could not reach the npm registry, so the release dates, dist-tags and the absence of a Biome plugin rest on my reading of [S1] alone. It reproduced every size in the two tables, the Biome result and the compiler-flag counts. The revised text has not had a second review round.

## Appendix: the Effect port of `clearDisk`

The fourth attempt, which passes the 14 tests of `packages/tscache/test/persist-clear-disk.test.ts` and the late-retry case. It was never added to the repository. `ClearDiskOptions` is the interface of the original module.

```ts
import { Effect, Schedule } from "effect";
import type { OpenStore } from "./hosted";
import type { PersistStore } from "./store";

export function clearDisk(
  openStore: OpenStore,
  options: ClearDiskOptions = {},
): Promise<void> {
  const debounceMs = options.debounceMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5000;
  const deadline = (options.startedAt ?? performance.now()) + timeoutMs;
  const left = () => deadline - performance.now();
  if (left() <= 0) return Promise.resolve();

  // Interruptible, unlike the acquire of acquireUseRelease, so that the
  // deadline answers the call while the database is still opening; a
  // database that opens after the interruption is closed unused.
  const open = Effect.callback<PersistStore | undefined, unknown>(
    (resume, signal) => {
      openStore({ ifExists: true }).then(
        (store) =>
          signal.aborted ? store?.close() : resume(Effect.succeed(store)),
        (error: unknown) => resume(Effect.fail(error)),
      );
    },
  );
  const clear = Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(restore(open), (store) =>
      store === undefined
        ? Effect.void
        : restore(
            // Checked before every attempt: a retry's timer may run late.
            Effect.suspend(() =>
              left() <= 0
                ? Effect.void
                : Effect.tryPromise(() => store.clearAll()),
            ).pipe(
              Effect.retry({
                schedule: Schedule.spaced(debounceMs),
                while: () => left() > debounceMs,
              }),
            ),
          ).pipe(Effect.ensuring(Effect.sync(() => store.close()))),
    ),
  );
  return Effect.runPromise(
    clear.pipe(Effect.timeoutOption(Math.max(0, left())), Effect.ignore),
  );
}
```
