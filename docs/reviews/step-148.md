# Step 148 — `hydrate`'s errors stop printing snapshot values

Branch: `fix/148-hydrate-errors-no-input` · Reviewer: Codex (gate) · Rounds: 1 · Status: round 1 fixed, awaiting round 2

## Scope

Step 146 stopped `decodeSnapshot` quoting a non-object input and listed, as decision concern 1, the
`hydrate` messages that still printed a value the snapshot supplied (`docs/reviews/step-146.md`, Sweep of
other messages). The user chose option (a), name the type only, on 2026-11-25 (user decision #142 A), and
left the treatment of finite numbers to the contract-test author. `packages/tscache/src/segment/payload.ts`
and `packages/tscache/src/engine/snapshot.ts` are protected paths; this edit is user-approved, and the PR
is for the user's merge.

## The contract-test author's refinement

The author (Codex) chose **type only for every rejected value, finite numbers included**. Reason, as
recorded at the top of `packages/tscache/test/cache-hydrate-rejections.test.ts`: a caller that logs the
error should not log a numeric identifier or timestamp supplied as the rejected value either. A message may
still say whether a number is finite: the tests accept `got`, `received` or `found`, then `a`/`an`, then
`empty `, `finite ` or `non-finite `, then the type.

## What changed

- **`segment/payload.ts`.** A new module-level `kindOf(value)` describes a supplied value by its type only:
  `null`, `undefined`, `a finite number`, `a non-finite number`, `an empty string`, `a string`, `an array`,
  `an object`, or `a <typeof>` otherwise (`a boolean`, `a bigint`, `a symbol`, `a function`). It is exported
  from the module for `engine/snapshot.ts` and from no package entry. The messages that printed the
  rejected value now name the field and its kind:
  - `gridMismatch` (the envelope, each payload, and the restore check that only tests for a mismatch):
    `format must be 1 or 2, got …`; `interval must be the cache grid's <own interval>, got …`;
    `alignmentOffset must be the cache grid's <own offset>, got …`. The cache's own interval and offset
    are configuration, not snapshot text.
  - `layout must be "dense", got …`; `start must be an aligned safe-integer timestamp, got …`;
    `count must be a positive integer, got …`; `startSlot must be the slot of start <start> here, got …`;
    `field "<name>" dtype must be <dtype> as the schema says, got …` (name and dtype from the schema).
  - `count ${p.count} exceeds the slot cap` became `count exceeds the slot cap <cap>`: the count had passed
    its type check, but it is still the rejected value.
- **`engine/snapshot.ts` `checkMeta`.** `version must be a non-empty string, got …` and
  `finalizedUntil must be a number, got …` use `kindOf`. A number that `slotAtOrAfter` refuses no longer
  forwards that function's `InvalidRangeError` message, which prints the value; it is now
  `finalizedUntil must be a timestamp within ±(2^53 - 1) with a grid point at or after it, got …`.
- **`errors.ts` is unchanged.** `show` keeps its other callers, which print configuration and protocol
  values on purpose. Step 146's `kindOf` in `src/snapshot.ts` is left as it is: sharing one helper would
  touch a third protected file, and that module names only non-objects.
- **Documentation.** `docs/releases/0.3.0.md` gains a Compatibility bullet (messages reworded; match the
  prefixes). Three places said `hydrate` quotes a payload field it refuses, which is no longer true, and
  now name only `JSON.parse`: `site/usage/snapshots.md` (the hydration tip), and the `nameOf` TSDoc in
  `integrations/shared/connection.ts` and `examples/mock-backend/src/hydration.ts`. These three are outside
  the brief's file list; each change is comment or prose only.

`integrations/test/hydration.test.ts` and `examples/mock-backend/test/hydration.test.ts` build refusals
from literal strings in the old wording (`field "v" has dtype unknown op, …`); they are fixtures for the
seeding path, not assertions about engine text, and are unchanged.

## Tests

The contract, written by the contract-test author before this change: block `hydrate error text — step
148` in `packages/tscache/test/cache-hydrate-rejections.test.ts`, 46 cases.

| Test | Field(s)                                                                    | Cases |
| ---- | --------------------------------------------------------------------------- | ----- |
| V13  | envelope `format`, `interval`, `alignmentOffset`                            | 12    |
| V14  | payload `format`, `interval`, `alignmentOffset`, `layout`, `start`, `count` | 21    |
| V15  | calendar payload `startSlot`                                                | 4     |
| V16  | payload field `dtype`                                                       | 1     |
| V17  | metadata `version`, `finalizedUntil`                                        | 8     |

Each case asserts the message prefix, the field name as a word, the absence of a marker string and of the
number's text, and a `got`/`received`/`found` clause naming the kind. Against the sources at `9029423b`
(the contract tests applied, `-t "step 148"`), 45 failed and 1 passed: the marker object `version`, which
`show` already printed as `an object`. With the change all 46 pass, and the file passes whole (194 tests).
No existing assertion pinned the old wording; no test was changed.

## Sweep of the other hydrate-path messages

Messages that still print a number from the snapshot, each one already validated and printed as context
rather than as the rejected value, kept as the brief allows:

- `startSlot must be the slot of start <start> here`: `start` has passed `slotOf` (an aligned safe-integer
  timestamp of this grid) when this check runs; the rejected value, `startSlot`, is named by kind.
- `coverage[i] reaches past finalizedUntil <t>` (`engine/snapshot.ts` `checkCoverage`): `t` has passed
  `checkMeta`, and architecture §4.5 and N69 give this exact message as their example. The rejected value is
  the coverage range, which is not printed.
- `format <1|2> names another kind of grid than the cache's`: the value is one of the two literals, which
  identifies nothing.

Messages that print only values derived from validated input or from configuration, unchanged:
`rangeSlots must be the slots [a, b] of the range here` and `coverageSlots[i] must be the slots [a, b] …`
(slots computed from the validated range and coverage); the charge message (entry counts, the charge and the
budget); `mask must be a Uint8Array of <n> bytes` and `field "<name>" data must be an ArrayBuffer of <n>
bytes` (sizes from the validated count and the schema); `field "<name>" is missing` (the schema's name).
Every other `fail` in both files prints fixed text and array indices. The RPC server passes `hydrate`
through to the engine without its own value checks, and `decodeSnapshot` was settled in step 146.

## Contract-test changes

None.

## Decision concerns

1. **Validated contextual values (above).** `start` in the `startSlot` message and `finalizedUntil` in the
   coverage message are snapshot-supplied timestamps; by the author's own reason (a logged timestamp can
   disclose data) they could go too. Options: (a) keep them, as the brief allows, since each is context
   for the rejected field and the coverage message is the documented example; (b) drop them in a follow-up,
   amending the N69 example. Recommended: (a).

## Pre-review and security lane, before round 1

Fable pre-review at `a2fa9f6e`: one P1 and one P2, both valid and fixed. Security lane (Claude), run 1:
no findings (`~/code/tscache-reports/reviews/step-148/pre-review-1.md` and `security-1.md`, outside the
repo).

| Finding                                                                                                                                                                                        | Verdict    | Fix                                                                                                                                    | Test                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The over-cap message (`payload.ts` `checkSpan`) lost the count, but no test pinned it: every V14 `count` input stops at "must be a positive integer", so restoring the old text failed nothing | Valid (P1) | None needed in the source: the message already prints only the cap. It keeps its wording, with no `got` clause, so no bytes are added. | V14b: a count of 987 654 against a cap of 8; the message starts `invalid segment payload: count exceeds the slot cap` and does not contain `987654`. Red-checked by restoring `count ${p.count} exceeds the slot cap`; it failed, and passes on the restored source. |
| The release note said `hydrate` prints "no value the snapshot supplies", while three messages still print a validated value as context                                                         | Valid (P2) | `docs/releases/0.3.0.md` now says the errors no longer print the value of a field they refuse, as `site/usage/snapshots.md` says.      | Prose only.                                                                                                                                                                                                                                                          |
| Decision concern: `start` in the `startSlot` message is validated on the first read, but the message read `p.start` again; an `Engine.hydrate` caller passing an accessor printed text         | Valid      | Director decision #149 C (below): `checkSpan` reads `start` once into a local, converts and validates that local, and prints it.       | V15b: a calendar payload whose `start` returns the valid instant on the first read and the marker afterwards, with a wrong `startSlot`. The message must name the `startSlot` check and not contain the marker. It failed before the fix (it printed the marker).    |

## Director decision #149 C (2026-11-26, overnight grant)

Question: four `hydrate` messages still print an already-validated value as context: `start` in the
`startSlot` message, `finalizedUntil` in "coverage[i] reaches past finalizedUntil", the slot pairs in the
`rangeSlots` and `coverageSlots` messages (a slot maps back to a timestamp through the cache's grid), and
`format`, which can only be 1 or 2. Keep them, or drop them?

- **A: keep all four as validated context.** No spec change and useful messages; none is the rejected value,
  which is what #142 A asked for. But a snapshot's timestamps can appear in a logged error, and the second
  read of `start` leaves the accessor case open.
- **B: drop all four (type only everywhere).** One rule for every message, matching the contract-test
  author's reason, and fewer bytes. But it amends architecture §4.5 rule 4 and the N69 example, normative
  wording of a decided rule, and the messages say less.
- **C: A, plus reuse the validated local for `start`.** Closes the only path that printed text, with no spec
  change and no added bytes. Timestamps can still appear as context.

Taken: **C**, by the director under the user's overnight grant, because it closes the only demonstrated
text leak without amending a normative rule while the user is away. **B stays open for the user** as a
follow-up, which would cover all four messages together.

## Round 1 (Codex)

Run at `3c99b01e`. Verdict: merge after fixes. The director's finding check (Fable) found four findings
valid and one partly valid (`~/code/tscache-reports/reviews/step-148/check-1.md`, outside the repo). The
contract-test author (Codex) wrote V18 to V20 first, in the step 148 block of
`packages/tscache/test/cache-hydrate-rejections.test.ts`. Each test reads a field through a getter whose
first read differs from later reads, so a check and its message that read the field separately disagree.
Against the sources at `3c99b01e` all 10 cases failed; with the fix all 10 pass. No existing assertion was
changed.

| #    | Sev | Finding                                                                                                                                                                                                                  | Decision                               | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1  | Reading `start` can bypass the hydration error handler (`payload.ts` `checkSpan`): a `start` getter that throws on its first read escaped as a raw error, where `main` gave a `TscacheError` (its catch re-read `start`) | accepted (finding check: VALID)        | `checkSpan` reads `start` inside the `try` that converts it, so a throwing read reports `start must be an aligned safe-integer timestamp, got undefined`. Test: V18, a `start` getter that throws a `RangeError` carrying a marker once, then returns the valid start; the message must match that prefix and contain neither the marker nor the start's digits                                                                                                                                                                                       |
| R1-2 | P1  | Diagnostics can report the type of a different value: `interval`, `alignmentOffset`, `layout`, `count`, `startSlot` and `dtype` were read once for the check and again for the message                                   | accepted as P2 (finding check: PARTLY) | Partly: reproduced for every field named, but `main` re-read the same way and printed the value itself, and decision #142 A holds. One local per diagnosed field now serves both the check and its message: a destructure in `gridMismatch` (envelope and payload), `layout` in `checkGrid`, `count` in `checkSpan`, `startSlot` in a nested `if` (the smallest form), and the entry's `dtype` in `checkFields`. Test: V19, eight cases, each getter giving a wrong kind first and the valid value after; the message must name the first read's kind |
| R1-3 | P2  | The release note and the hydration tip overstate which values are omitted: the format literal is still printed, not every message names a type, and a few print a validated value as context                             | accepted (finding check: VALID)        | `docs/releases/0.3.0.md` and `site/usage/snapshots.md` now say the refused value is not printed except a format of 1 or 2, that most messages (not all) name the type received, and that a few print an already-validated timestamp or slot index as context (decision #149 C), so logging the error's name only remains the advice. Prose only                                                                                                                                                                                                       |
| R1-4 | P2  | The watermark diagnostic omits the calendar domain (`snapshot.ts` `checkMeta`): on a calendar grid a watermark inside ±(2^53 − 1) can still be refused for lying outside the calendar's domain                           | accepted (finding check: VALID)        | The message names the bound that applies: `within ±(2^53 - 1)` on a fixed grid, `inside the calendar's domain` on a calendar grid, still with the kind and no value. Test: V20, a daily UTC snapshot whose `finalizedUntil` is 1 ms before year 1; the message must name the calendar's domain and contain no digit                                                                                                                                                                                                                                   |
| R1-5 | nit | Two intermediate commits (`cc16f903`, `4f888ee7`) fail `tsc --noEmit -p packages/tscache`; `3c99b01e` repairs the tip                                                                                                    | accepted (finding check: VALID); open  | The fold of `3c99b01e` into `cc16f903` was refused by this machine's history-rewrite guard, so the branch keeps the two red commits. A follow-up for the user: allow the fold of the unpublished branch, or accept the two commits as they are. Every commit added in this round passes `tsc --noEmit -p packages/tscache`                                                                                                                                                                                                                            |

Size after the fixes (`bun run size`, brotli): `index (lazy)` 18 545 bytes against a budget of 18 576, the
same as before the round: the two P1 fixes (with `startSlot` in the nested `if` form) save 7 bytes and the
watermark's grid branch costs 7. Every other entry is within its budget.
