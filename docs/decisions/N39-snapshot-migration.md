# N39: Migration to snapshots

Row N39 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**In the step that adds the API, with no legacy path**: `putCovered`, `putSeeds`, `dehydrate`/`rehydrate` and the `Dehydrated`/`Hydration` types go; the integrations' `Seed` carries the read and its snapshot; both server-rendering examples and the six integration snippets move to `hydrate`. Whether `integrations/shared/connection.ts` keeps seeding only the first client, as a belt for unversioned datasets, is proposed in the step ⑮ architecture text. Rejected: keeping the old helpers beside `hydrate` (two hydration paths to test, and the old one keeps the seed race). User-confirmed 2026-10-23. **Amended 2026-11-10 (wording only):** the old functions and types are gone from the package; the names `dehydrate`, `rehydrate`, `Hydration` and `Dehydrated` survive as helpers in `examples/mock-backend/src/hydration.ts` and `integrations/shared/hydration.ts`, built on the snapshot API (step ⑮ commits 4d18782 and 7cc7f1b).
