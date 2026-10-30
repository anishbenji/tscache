# Chore 40 — Documentation truth sweep

Branch: `chore/40-docs-truth-sweep` · Reviewer: Codex (high) · Rounds: 1 · Status: settled

Brings the READMEs and contributor documents back in line with the code merged since 2026-10-23. A truth sweep: each change corrects a statement the code contradicts, and nothing else is reworded. Implemented by a Claude Opus 5.5 subagent while the user was away, under the user's grant of 2026-10-30.

## Scope

| Commit | What |
|---|---|
| a2e0559 | `integrations/README.md` "Checks and limits", the four framework READMEs, and the "Known limits" of `examples/react-ssr` and `examples/solid-ssr`: seeds go through `hydrate`, which refuses another version's snapshot and fills only what the cache does not cover (architecture §2.8, N35) |
| 2c5da75 | `examples/mock-backend/src/fetcher.ts` gathers response fields in a prototype-free dictionary; test first |
| 9e4bf92 | `docs/review-checklist.md` §4 lists every member of the `Segment` interface |
| 0505873 | `docs/roadmap.md`, persistence sketch: the snapshot API is built |
| (this commit) | This file |

## Contradictions fixed

| # | Where | Stale claim | What the code does |
|---|---|---|---|
| C1 | `integrations/README.md`, "Checks and limits" | A seed carries no dataset version; checking coverage and putting the seed are two requests, so another tab's fetch between them is replaced; closing both needs a library snapshot API | `hydrateRead` (`integrations/shared/hydration.ts`) calls `cache.hydrate`: one engine call that refuses a snapshot of another version and writes only slots the cache does not cover (§2.8, N35). The remaining limit, an unversioned dataset restated after the server's read, is kept |
| C2 | `integrations/{angular,solid,svelte,vue}/README.md`, "Known limits" | "A seed carries no dataset version" | As C1; each now points at the shared limit in `integrations/README.md` |
| C3 | `examples/react-ssr/README.md`, `examples/solid-ssr/README.md`, "Known limits" | "The mock backend reports no dataset version, so the snapshot carries none" | The mock backend has reported `meta.version` (`v1` until a restatement) since before the snapshot step (`backend.ts`, `fetcher.ts`, also at 4d18782). Checked with a throwaway in-process probe: a server read of `candles/ACME` with `snapshot: true` returned `snapshot.version === "v1"`. The true part, that a backend without versions gets no check, is kept |
| C4 | `docs/review-checklist.md` §4 | The `Segment` interface is `lookup`, `slice`, `mergeFrom`, `transferPayload` | `segment/types.ts` also has `countIn` and `sliceInto` (step 33, #51) and the `extent` and `size` properties |
| C5 | `docs/roadmap.md`, persistence sketch | "The SSR snapshot API below would serialise the same page records, so the two should be designed together" | Built in step ⑮; its envelope is the sketch's cache record (§2.8, N34) |

## Bug fixed

**Mock fetcher fields named like `Object.prototype` members.** `collect` gathered fields on `{}`, so `fields["constructor"] ??= []` found the inherited `Object` function, and appending to it threw `TypeError: target.push is not a function`; a `__proto__` field met `Object.prototype` the same way. The new test in `examples/mock-backend/test/fetcher.test.ts` serves two raw JSON pages with `constructor` and `__proto__` fields; it failed with that `TypeError` before the change and passes after it. The dictionary is now `Object.create(null)`.

## Checked and left alone

- `docs/review-checklist.md` §4, other items: the mask is `ceil(count / 8)` bytes with one bit order in `dense.ts` and `payload.ts`; the default slot cap is 32 768 (`engine/validate.ts`); the overlap warning is off by default (`warnOnOverlapDiff`), and the development `console.warn` of #49 prints only warnings that exist when it is on. The engine constructs `DenseSegment` in `merge.ts` and `snapshot.ts`, which uses the class, not its internals.
- Bench defaults (#50): `docs/benchmarking.md` and `packages/tscache/bench/setups.ts` agree on 100 ms batches and 30 rounds for `compare`, and on 40 ms and 20 rounds for the end-to-end scenarios and the earlier setups.
- `docs/benchmarking.md`, "How this setup was chosen": "the planned fast path in `DenseSegment.slice`" describes the state when the design was chosen, inside a historical account; step 22 is recorded as done in `docs/roadmap.md`.
- `docs/guides/worker-setup.md`, `docs/guides/patterns.md`, `README.md`, `reference/README.md`, the other example READMEs, `AGENTS.md` and `docs/workflow.md` (hook staging against `lefthook.yml` and `scripts/ci.sh`, the Codex model against `.codex/config.toml`): no contradiction found.
- `docs/architecture-review.md` is the agenda of the 2026-10-23 review, and `docs/reviews/` is history; neither was edited.

## Decisions

- **C3 corrected, contrary to the brief.** The brief named the mock backend's missing version as a statement to keep; the code and a probe show it reports one, so the statement was corrected rather than kept.
- **Framework READMEs point at the shared limit** instead of repeating it, as they pointed at an example README before.

## Contract-test changes

None.

## Decision concerns

None.

## Round 1 — reviewer verdict: merge

No findings; `bun run ci` passed on the branch rebased onto `main` 15fa506. Settled. Reviewed and settled by the director while the user was away.
