# Step 146 — `decodeSnapshot` stops quoting its input in the error

Branch: `fix/146-snapshot-error-no-input` · Reviewer: Codex (gate), with a Claude pre-review and the security lane · Rounds: 2 · Status: settled after round 2 (its one P2 fixed; no further gate round) · Verdict after triage: merge

## Scope

Step 137 (PR #173, note 2) found that `decodeSnapshot` quoted a non-object input whole in its error message: `packages/tscache/src/snapshot.ts` called `fail(\`must be an object, got ${show(e)}\`)`, and `show` (`packages/tscache/src/errors.ts`) returns `String(value)`for a primitive. A snapshot that arrived as a string, such as a server read that was never parsed, was printed in full, so an application that logged the message logged the snapshot. The user asked for the fix as its own step (2026-11-25).`snapshot.ts` is a protected path; this edit is user-approved.

## What changed

- **`packages/tscache/src/snapshot.ts`.** A local `kindOf` describes a value that is not an object by its type only: `null`, `undefined`, `an array`, or `a <typeof>` (`a string`, `a number`, `a boolean`, `a bigint`, `a symbol`, `a function`). The message is now, for example, `invalid encoded snapshot: must be an object, got a string`. The module no longer imports `show`.
- **`packages/tscache/src/errors.ts`** is unchanged. `show` has callers that rely on the value it prints (`grid.ts`, `segment/payload.ts`, `engine/snapshot.ts`, `engine/validate.ts`, `engine/cache.ts`, `engine/batch.ts`, `rpc/port-client.ts`, `rpc/server.ts`, `rpc/protocol.ts`): configuration errors that print the offending option, and protocol errors that print a version or op. Changing it would change those messages.
- **`docs/releases/0.3.0.md`.** One Compatibility bullet describes the new message.

No guide, TSDoc or `site/` page quoted the old message (`git grep "must be an object, got"` finds only source). Three places described the behaviour instead; the Claude pre-review found them and they now name what still quotes (see Pre-review). `docs/INDEX.md` is unchanged: its single `docs/reviews/` row covers every step file and carries no size.

## Tests

`packages/tscache/test/snapshot-codec.test.ts`, block `decodeSnapshot error text — step 146` (C07): a string holding a marker, a number, a boolean, a bigint and a symbol each throw `TscacheError` with the exact message naming the type, and the message contains neither the marker nor the value's text. Before the fix these five failed (the message quoted the value); `null`, `undefined` and an array already passed and are pinned too. No existing assertion pinned the quoted value.

## Assertion change in the step-137 test (fix 1)

`bun run ci` failed `integrations/test/connection.test.ts`, "never quotes a snapshot whose error would quote it" (step 137). Its precondition, `expect(message).toContain(marker)`, asserted that `decodeSnapshot` quoted a string snapshot whole: the behaviour the user asked this step to remove (2026-11-25). The director approved changing that precondition under the user's step-146 decision.

- **The changed precondition.** It now asserts the new behaviour: the message starts `invalid encoded snapshot` and does not contain the marker. Every warning assertion of the test is kept: the read still fetches, the warning is given once, names `TscacheError` and does not contain the marker.
- **A new case beside it**, "never quotes a snapshot whose hydrate error quotes a field it supplies". The old precondition also proved that the warning is tested against an error that does quote input text; with `decodeSnapshot` no longer quoting, that proof moves to the hydrate path. A payload field's `dtype` is any string to `decodeSnapshot`, and `segment/payload.ts` prints a mismatching one through `show`. The test sets the first field's dtype to the marker, proves through the real seeding path (`rehydrate`, then the handle's `hydrate`) that the error starts `invalid segment payload` and contains the marker, and then asserts that the connection's warning names the error (`(${name})`) without the marker, and that the read still fetches.

This is stricter, not weaker: the warning is still tested against an error that quotes the snapshot's text, and `decodeSnapshot`'s own message is now pinned not to quote it. Of the other hydrate-path fields in the sweep below, `version`, `format`, `interval`, `alignmentOffset`, `start`, `count`, `startSlot`, `finalizedUntil` and `layout` cannot carry text past `decodeSnapshot` (it requires a string `version`, which hydrate prints only when it is not a non-empty string, a format of 1 or 2, `"dense"`, and numbers), so the dtype is the one input that reaches the warning through the seeding path with text in its error.

## Sweep of other messages

- **`snapshot.ts`, every other `fail`.** Each prints a fixed text and a path built from array indices and fixed keys (`segments[0].fields[1].data`, `coverageSlots[2]`); none prints a field name, dtype or other text the input supplies. No change.
- **The hydrate path** (`engine/snapshot.ts`, `segment/payload.ts`) prints input values through `show` in these messages, each a string when the input supplies one:
  - `segment/payload.ts` `gridMismatch`: `unsupported format ${show(format)}`, `interval ${show(stored.interval)} differs …`, `alignmentOffset ${show(stored.alignmentOffset)} differs …` (used for the envelope and for each payload);
  - `segment/payload.ts`: `unsupported layout ${show(p.layout)}`, `start ${show(p.start)} is not …`, `count must be a positive integer, got ${show(p.count)}`, `startSlot ${show(p.startSlot)} is not …`, and `field "<name>" has dtype ${show(entry.dtype)}, …` (the name is the schema's, the dtype the input's);
  - `engine/snapshot.ts` `checkMeta`: `version must be a non-empty string, got ${show(version)}` (a non-string version) and `finalizedUntil must be a number, got ${show(finalizedUntil)}`.

  The coverage watermark message prints a number already checked. These are short fields rather than a whole snapshot, and a value that passed `decodeSnapshot` has a number or string of the right type in each, but a snapshot handed to `hydrate` directly can carry any text there. Both files are protected paths (Never from 0.1.0) that this step's approval does not cover, and their messages are engine logic under strict test-first, so they are not changed here; see Decision concerns.

## Contract-test changes

None.

## Decision concerns

1. **Hydrate-path messages that print input text** (listed above). Options: (a) a follow-up step that names the type only in those messages, as here, with a test for each (engine logic, so Codex writes the failing contract tests first; both files are protected, so the user approves the edit); (b) bound the printed text instead, for example to its first 32 characters; (c) leave them, since they print one field's value and not the snapshot. Recommended: (a), for the same reason as this step: an application that logs `hydrate`'s error should not log text the snapshot supplied.

## Pre-review (Claude), before round 1

Fable pre-review on the fix commit and its triage commit: no P0 or P1, two P2s, both fixed by the director.

| Finding                                                                                                                                                                                       | Verdict    | Fix                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Docs and TSDoc still say `decodeSnapshot` quotes a non-object input (`site/usage/snapshots.md`, `nameOf` in `integrations/shared/connection.ts` and `examples/mock-backend/src/hydration.ts`) | Valid (P2) | Each now names what still quotes: `JSON.parse`, and `hydrate` for a payload field it refuses.                                           |
| Test names and comments still claim a quoting `decodeSnapshot` error (`integrations/test/connection.test.ts`, `examples/mock-backend/test/hydration.test.ts`, `site/scripts/run-snippets.ts`) | Valid (P2) | Retitled and recommented; assertions unchanged. The leak class stays covered by the `JSON.parse` cases and the integrations dtype case. |

Security lane (Claude), run 1: no findings (`~/code/tscache-reports/reviews/step-146/security-1.md`, outside the repo).

The pre-review also noted that the integrations dtype case pins `hydrate` quoting its input; if user decision #142 goes with option A, that step changes the precondition (for example to a constructed error).

## Round 1 (Codex), head before the history rewrite

Verdict: merge after fixes. The director's finding check (Fable) found both findings valid.

| #    | Sev | Finding                                                                                                                                                                                                                                                                                                   | Decision                        | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1-1 | P1  | A revoked callable proxy throws the wrong error. `kindOf` in `snapshot.ts` called `Array.isArray` on every non-null value, and `Array.isArray` throws a native `TypeError` on a revoked proxy. On `main`, `decodeSnapshot` throws the documented `TscacheError` for it (checklist §10, architecture §2.8) | accepted (finding check: VALID) | `kindOf` calls `Array.isArray` only when `typeof value === "object"`, so a callable proxy, revoked or not, is named "a function". Tests first, in the step 146 block of `snapshot-codec.test.ts`: a plain function and a revoked callable proxy (`Proxy.revocable(() => {}, {})`, revoked) each throw `TscacheError` with exactly "invalid encoded snapshot: must be an object, got a function". Before the fix the proxy case failed (`expected TypeError: Cannot perform 'IsArray' on a … to be an instance of TscacheError`); the plain function passed. Revoked object and array proxies are unchanged: they throw `TypeError` on `main` too (`isObject`), so they are not a regression of this step |
| R1-2 | nit | Two intermediate commits left CI red: the fix commit and the triage commit changed the decoder while `integrations/test/connection.test.ts` still asserted the old quoting message, until a later test commit corrected it (AGENTS.md: the repo is green after every commit)                              | accepted (finding check: VALID) | The unpublished history was rebuilt from `main`: the fix commit now carries the connection test change, the triage commit carries its triage lines, and the docs commit follows unchanged except that the pre-review line names the reviewed commits in words instead of a hash that no longer exists. Every rewritten commit is authored and committed with the GitHub noreply address. At the new fix commit, `bunx vitest run integrations/test/connection.test.ts packages/tscache/test/snapshot-codec.test.ts` passed (79 tests)                                                                                                                                                                    |

Security lane (Claude), run 2, on the rewritten history: no findings.

## Round 2 (Codex)

Verdict: merge after fixes. Both round 1 fixes confirmed; no new code findings. The director's finding check (Fable) found the one finding valid.

| #    | Sev | Finding                                                                                                              | Decision                        | Resolution                                                    |
| ---- | --- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------- |
| R2-1 | P2  | This file's header said `Rounds: 0 · Status: settled` while the file recorded a round 1 P1 that required a re-review | accepted (finding check: VALID) | Header updated to two Codex rounds and settled after round 2. |

Settled after round 2: no P0 or P1 in round 2 (docs/workflow.md, step 6).
