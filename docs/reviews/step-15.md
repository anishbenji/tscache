# Step 15 — Snapshot API (hydrate, encode/decode) and the migration of server-rendering hydration

Branch: `feat/15-snapshot` · Reviewer: GPT-6.1 Sol (high) · Rounds: 2 · Status: settled · Verdict after triage: merge

Step ⑮ is the first item of the post-build architecture review (`docs/architecture-review.md`, item 1; decisions N34–N39 in `docs/architecture.md` §8). An engine step: the architecture text comes first, then Codex writes the contract tests from it (prompt A, `docs/workflow.md`), then the implementation, the migration of the ⑬b and ⑭ helpers and the guide's server-rendering section, then the review loop.

## Architecture text (approved 2026-10-23)

Commit `docs(architecture): snapshot api text for step 15` adds §2.8 Snapshots, the `hydrate` op in §3.2, the envelope note in §3.4, two modules in the §4 layout, and the `CacheState`, `Engine`, RPC, handle and orchestrator contracts in §4.5–§4.9. Everything follows N34–N39; the points below are where the text fixes a shape or rule the rows left open, each with the alternatives considered. The user approved the recommended option at every point (2026-10-23), so the text stands as committed.

| # | Point | Text says (recommended) | Alternatives |
|---|---|---|---|
| T1 | A `range` field in the envelope (not in N34's field list) | Included: the request, snapped outward. Makes a snapshot self-describing, lets `hydrate` check that coverage and payloads lie inside it, and lets a future reader derive the `misses` of a `GetResult` | Leave it out, as N34 listed: one field fewer; a reader would take the range as an argument, and a hostile snapshot's coverage could not be bounded |
| T2 | What `encodeSnapshot` returns | A plain JSON value (`EncodedSnapshot`: the envelope unchanged, each payload's mask and field data as base64 strings). The app serialises it with `JSON.stringify` next to its own data (the columns it renders), so one script element carries both forms without double encoding | A string (`JSON.stringify` done inside): simpler signature, but an app embedding it beside other data must nest JSON in JSON or use a second script element |
| T3 | The receiving cache's volatile region | `hydrate` writes nothing there: a part is the snapshot's coverage minus the cache's coverage and minus its volatile region (after the watermark advance). N35 clipped only the coverage claim there, which would still let a seed's points replace the browser's provisional points inside an applied part until the next `get` refetches them | Put semantics as N35 reads literally: points replaced inside the volatile region, coverage clipped. Same behaviour for every genuine snapshot whose watermark is at or ahead of the cache's; differs only when the browser alone moved its watermark forward |
| T4 | Malformed snapshots | Rejected with `TscacheError` before anything changes (no snapping of coverage ranges, no repair); no new error class (as N10 chose for payloads). A failure inside the snapshot is `TscacheError` even where the same value as a call argument would be `InvalidRangeError` | Snap unaligned coverage inward as `put` does for its range (N13): tolerant, but snapshots are machine-made, so a malformation is corruption, and tolerance hides it |
| T5 | Ownership of the buffers | A `get` result's snapshot is transferred to the page (fresh copies, as the result's arrays are); `hydrate` clones its snapshot to the worker, so the object stays usable, and a page can hydrate a replacement client from it. Cost: one copy of a page's worth of bytes per hydrate | Transfer on `hydrate` too (§3.3's rule for `put`): no copy, but the snapshot is detached after one use, which the integrations' seeding of every client (D6) would have to work around |
| T6 | Export surface | `encodeSnapshot`, `decodeSnapshot` and the types `Snapshot`, `EncodedSnapshot`, `EncodedSegmentPayload`, `HydrateResult`, `DenseSegmentPayload` from both `.` and `./engine`; `DenseSegmentPayload` becomes a public type (its shape is §3.4, unchanged) | `.` only (N38 named it): a Node user of `Engine` directly would import the `.` entry for the encoders |
| D6 | Does `integrations/shared/connection.ts` keep seeding only the first client? | **B. Seed every client.** The rule guarded against the defect `hydrate` removes: a stale versioned snapshot is refused, an unversioned one is no staler than at first render, and the tail is never seeded. A replacement after `workerLost` then starts from the page's data instead of refetching; `connection.ts` loses its `first` tracking. Needs the snapshot reusable (T5) | A. Keep the rule: a replacement never applies a page-old seed, at the cost of refetching history the page carries, for a risk identical to the first load. C. Seed every client only when the snapshot has a version, the first client otherwise: a belt for unversioned datasets, two behaviours to explain and test |

Not in the text, deliberately: a reader that derives `GetResult` columns from a snapshot (N38 defers it); seeds applied at `cache()` (N36 rejected it); a protocol bump (N37).

## Contract tests (Codex, 2026-10-23)

Prompt A, headless (`codex exec -s workspace-write`, GPT-6.1 Sol high, one session under the silence watchdog). Six files in `packages/tscache/test/`: `cache-snapshot.test.ts` (S01–S10), `cache-hydrate-rejections.test.ts` (V01–V12), `cache-hydrate.test.ts` (H01–H11, P01 with 32 generated states), `engine-snapshot.test.ts` (E01–E05), `snapshot-codec.test.ts` (C01–C06) and `snapshot-test-helpers.ts`. Codex reported 234 failing and 1 passing before implementation, the existing 1137 passing with the new files excluded, Biome clean, and the failure-part-way rule skipped (needs allocation-failure injection). Nothing under `src/` was touched; nothing was committed, since contract tests land with the code that makes them pass.

Two ambiguities Codex left unpinned, settled in the text before implementation (commit below): an unaligned `range` inside a snapshot is rejected, since §2.8 says a snapshot is never snapped, where §4.5 had said "a range `snapOut` accepts"; and `decodeSnapshot` checks the shape and the base64 only, with every semantic check (lengths, ordering, alignment, schema) left to `hydrate`.

## Implementation (2026-10-23)

| Commit | What |
|---|---|
| 80c2f13 | `feat(engine)`: `CacheState`/`Engine` `snapshot`, `hydrate`, the `snapshot` option on `get`; `engine/snapshot.ts` (take, validate); `src/snapshot.ts` (`encodeSnapshot`/`decodeSnapshot`); `DenseSegmentPayload` moved to `types.ts` and public; exports from `.` and `./engine`. Codex's contract tests land here unchanged |
| fe48a01 | `feat(rpc)`: the `hydrate` op, a `get` result's snapshot buffers in its transfer list, the orchestrator's snapshot from the read it returns, `CacheHandle.hydrate`; wiring tests in `snapshot-wiring.test.ts` |
| 4d18782 | `feat(examples)`: the mock backend's hydration helper carries the encoded snapshot and applies it with `hydrate` (`seed`); both SSR examples read with `snapshot: true` and seed every client (D6-B); specs, READMEs, helper tests |
| 7cc7f1b | `feat(integrations)`: a server read carries its snapshot beside its columns; `hydrateRead` replaces `putCovered`; `connection.ts` seeds every client (D6-B); tests, comments, READMEs |
| f539868 | `docs(guides)`: the server-rendering section of `docs/guides/worker-setup.md` shows the snapshot flow; roadmap pointer |

Only an older worker's `unknown op` rejection counts as "not seeded" in the two helpers (N37); every other failure propagates. `main` (PR #26) was merged into the branch before the implementation commits.

## Round 1 — reviewer verdict: merge after fixes

| # | Sev | Finding | Decision | Resolution |
|---|---|---|---|---|
| R1-1 | P1 | Both hydration helpers swallow any error whose message contains "unknown op", including a validation error for a payload whose dtype is that text | accepted | Validated with a failing test in each helper's suite (a rejection whose message embeds the phrase must propagate). The helpers now match the RPC server's exact answer, `unknown op hydrate`, on a `TscacheError`; a wiring test pins that message format. The earlier tests had used a quoted message the server never sends (1df6e43, e8a7186) |
| R1-2 | P1 | `decodeSnapshot` accepts sparse arrays: `map()` skips holes in `segments`, `coverage` and payload `fields` | accepted | Validated with failing tests for each array. `Array.from` visits every position, so a hole reaches the shape check as `undefined` and is rejected (e8a7186). `hydrate`'s own validation already iterated with `entries()`, which visits holes |

## Round 2 — reviewer verdict: merge

No findings. The reviewer confirmed both round 1 fixes and their regression tests. **Settled.**

## Contract-test changes

None. The six Codex files pass unchanged.

## Decision concerns

None yet.

## Merge request: `feat/15-snapshot` → `main`

**Scope.** Step ⑮, the first item of the post-build architecture review: a snapshot API over the segment payload (N34–N39), and the migration of every server-rendering helper to it.

- **Library.** `get(range, { snapshot: true })` returns a `Snapshot` taken from the same state as the result: the §3.4 payloads of the present points clipped to the request, with the grid, schema, version, watermark and coverage. `CacheHandle.hydrate(snapshot)` (one new op, `hydrate`) validates it in full, refuses a differing dataset version, advances the watermark forwards only, and replaces only the parts the cache neither covers nor holds as provisional, in one engine call, which closes the seed race of step ⑭ (R2-2). `encodeSnapshot`/`decodeSnapshot` carry a snapshot through JSON with `NaN` intact. `DenseSegmentPayload` and the snapshot types are public from `.` and `./engine`. `PROTOCOL_VERSION` stays 1 (N37).
- **Migration.** The mock backend's hydration helper and `integrations/shared/hydration.ts` carry the encoded snapshot and apply it with `hydrate`; `putSeeds`, `putCovered` and their uncovered-range arithmetic are gone. Both SSR examples and the integrations seed every client, a replacement after `workerLost` included (D6-B). Only an older worker's exact `unknown op hydrate` answer counts as "not seeded"; every other failure propagates.
- **Docs.** Architecture §2.3, §2.8, §3.2–§3.4, §4.5–§4.9 (approved before the tests); the server-rendering section of `docs/guides/worker-setup.md`; the example and integration READMEs; the roadmap.

**Process.** Strict test-first: Codex wrote 279 contract tests from the approved text (six files, unchanged since); two ambiguities they surfaced were settled in the text before implementation. Review: two rounds. Round 1 found two P1s (the helpers' too-broad "unknown op" match; holes in arrays accepted by `decodeSnapshot`), both reproduced with failing tests and fixed; round 2 was clean.

**Confidence: high** for the engine (contract tests cover every documented rejection in order, the fill-only rule, the volatile region, round trip, idempotence and never-overwrite as generated properties over 32 states). **Medium-high** for the migration: the SSR specs now assert that a replacement worker is seeded and that the window is not refetched, but they run in Chromium only.

**Blast radius.** One new op and an optional `get` field: additive, protocol unchanged, so an old worker keeps working and a new page treats its refusal as not seeded. The examples' and integrations' hydration payload format changed (unpublished source). `bun run ci` passed on the branch: 1429 Node tests and 48 browser specs.

**Known limits.** The failure-part-way rule of `hydrate` (an allocation failure mid-write withdraws that part's coverage) is implemented as `put`'s is but not tested, since it needs allocation-failure injection. No adversarial pass was run: the workflow schedule does not list step ⑮; one focused on `hydrate`'s atomicity and version rules is available on request.

**For the user.** Review and merge. Next: `feat/16-vite-entry` (N40–N41); adding `vite` as an optional peer dependency is a decision you approved with D7-A, and its supported range is proposed in that step.
