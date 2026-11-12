# N9: Grid and coverage internals

Row N9 of the decision table in `docs/architecture.md` §8, whose introduction says how its rows were taken. The text below is that row, moved here unchanged in step 73. Decisions are locked (`AGENTS.md`); the architecture section lists every decision with a one-line summary.

## Resolution

**`grid.ts` holds every ms↔slot conversion** (`isAligned`, `slotOf`, `msOf`, `snapOut`, `toMs`); `coverage.ts` works on integer slot ranges only. Internal contract in §4.1. Rejected: conversion inside `coverage.ts` (no doc change, but two concerns in one module and the single-site rule harder to verify). User-confirmed 2026-10-03
