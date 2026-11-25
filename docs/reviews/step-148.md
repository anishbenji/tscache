# Step 148 — `hydrate`'s errors stop printing snapshot values

Branch: `fix/148-hydrate-errors-no-input` · Reviewer: Codex (gate) · Rounds: 0 · Status: awaiting review

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
