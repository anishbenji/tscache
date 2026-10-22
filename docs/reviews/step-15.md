# Step 15 — Snapshot API (hydrate, encode/decode) and the migration of server-rendering hydration

Branch: `feat/15-snapshot` · Reviewer: GPT-6.1 Sol (high) · Rounds: 0 · Status: architecture text approved; contract tests in progress · Verdict after triage: —

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

## Contract-test changes

None yet.

## Decision concerns

None yet.
