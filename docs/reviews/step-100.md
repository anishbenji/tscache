# Step 100 — Design spec for deploy skew (M5)

Branch: `docs/100-m5-deploy-skew-spec` · Reviewer: not yet run (the director starts the rounds) · Rounds: 0 · Status: awaiting review · Verdict after triage: —

## Scope

The third of the three design steps of user decision 46 A (2026-11-13: after 0.1.0, M7, then M3, then M5; each a spec first, then the user's decision rows, then contract tests). It answers finding M5 of the review of 2026-11-10 (`docs/reviews/2026-11-review.md`, M5 and §3d): a protocol mismatch rejects `createClient` with no recovery, and with hashed worker URLs two deploys run two SharedWorkers silently, both writing one IndexedDB database.

Documentation only: no code, no tests, nothing under `packages/` changes.

| Commit (by subject)                                   | What                                                                                                                                                           |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs: propose the deploy-skew design for finding m5` | `docs/design/m5-deploy-skew.md`; a deploy-skew sketch in the roadmap linking to it, next to M7's and M3's; the `docs/design/` row and sizes in `docs/INDEX.md` |
| `docs(review): step 100 scope and verification`       | This file; the `docs/reviews/` row of `docs/INDEX.md`                                                                                                          |

**Where the design lives.** A proposal file beside M7's and M3's, for the reason they give: the architecture document records approved contracts, and this design has fifteen open rows, four of which would amend approved text (§4.8 and §4.10.8 by F1; §4.10.7 with N52 by F5; §4.10.7 with N54 and N66 by F11; the checklist's §12 item). The contract-test step moves the approved text into architecture §2.1, §2.7, §3.2, §4.8 and §4.10.6–§4.10.8.

**What it covers,** as the brief asked: how a deploy reaches open tabs today (the worker URL and the absent name, SharedWorker identity, `hello` and its unread `lib`, the protocol and fetcher checks, what an old and a new tab each see, per way of serving the worker); the failure shapes, rejected at connect (protocol mismatch, fetcher conflict) and silent (two workers side by side, with what each writes to IndexedDB when structure, dataset version, layout or record format differ; one worker serving two deploys); the options the brief listed (a build id in the hello or an op, a name stable across deploys, a broadcast to old tabs, a database lock or owner record, a read-only mode for the older engine, an event, an error or a flag); the interaction with M7 (the compatibility rule, D9's `features`, `cacheChanged`) and M3 (E3, E18, E20, two budgets during a skew); the cost when nothing is skewed (zero per operation and per port message); the public API change and its version; and the contract-test list, split into Codex-first persistence tests and tests written with the code.

**The design, in short.** The SharedWorker is named by a generation key, `tscache:<LIB_VERSION>:<fetcher module>`, so pages that would run different code in the worker never share one, at a fixed or a hashed URL; this removes the protocol mismatch and the fetcher conflict against a running worker. Workers announce themselves on a `BroadcastChannel`; a worker that hears a higher-ranked worker of another generation (higher library version, then later start) stops persisting for its life without a cleanup deletion (the path a failed `clearAll` already takes), keeps `clearAll`'s disk clear, and tells its tabs with a `superseded` event and a `client.superseded` property. A `clearAll` from any hosting reaches every SharedWorker over the same channel. The handshake is unchanged and `PROTOCOL_VERSION` stays 1.

**A finding the spec makes about current text.** The guides and architecture §4.10.7 say a hashed worker URL gives each deploy a SharedWorker of its own (`site/guides/workers.md:146-147`, `docs/architecture.md:1707`). A probe (two Vite builds of `examples/react-lwcharts`, the second with one constant added to the fetcher; both edits reverted) showed the worker file name unchanged in both the `es` and the `iife` worker formats while the fetcher's changed. A deploy that changes only the fetcher therefore keeps the worker URL, and every new tab is refused with `ConfigError` ("this worker already runs fetcher …") until the old tabs close. The known limit in the guides does not say so. The proposal's §7 records the correction, which is documentation alone and can ship before the design; this step does not make it, since the brief limits it to the proposal.

**Claims checked against the code.** Every statement about the current engine in the proposal's §2 and §3 cites a file and line on `main` at `2fc4308`; each was read at those lines with `cat -n`, `sed -n` or `grep -n`, not inferred. The architecture, guide and decision citations (§3.1, §4.10.2, §4.10.7 at lines 1705–1723, §4.10.8 at 1743; N20, N25, N30, N32, N37, N44, N52, N54, N66; `site/guides/workers.md:132-178`, `site/troubleshooting.md:17-25`, `site/guides/persistence.md:84-86`, `docs/guides/patterns.md:149-171`) were read in full. The statement that a SharedWorker is found by URL and name together is from the HTML Standard; the proposal's Playwright tests 14 and 17 and the name test 9 pin the behaviour the design relies on.

## Decisions for the user

All fifteen rows, F1–F15, are open and listed with options, pros, cons and a recommendation in §5 of the proposal. None is decided here; the proposal's §4 assumes each recommendation. Rows whose recommended option needs the user's explicit approval because it amends a locked decision or approved text:

- **F5 (a)** (a superseded worker stops persisting for its life) narrows the two-writer overlap that N52 accepts and changes what N52 and architecture §4.10.7 describe. It adds no lock, no disk read and no persistence in another hosting, so N52's single-writer design stands.
- **F11 (a)** (`clearAll` reaches every SharedWorker over the channel, not awaited) extends what N54 and N66 say `clearAll` reaches, and §4.10.7's last paragraph.
- **F1 (a)** (the SharedWorker is named) amends the approved sentence of §4.8 and §4.10.8 that every tab of a deploy passes the same options; no locked decision.
- The review checklist's §12 item on two engines writing one database (a protected path the user owns) changes with F5 (a) and F11 (a).

Options that would change a locked decision and are not recommended: F2 (d) with a build id in `init` and M7's D9 (a) used for it (§3.1, the handshake); F3 (b) (renames N32's lock); F13 (b) (N25 and N30).

## Verification

| Check                                                                | Result                                                                                                                         |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `bun run --cwd packages/tscache build`, then `bun run docs:check`    | exit 0; `doc-anchors: 246 anchors in 42 pages resolve`                                                                         |
| `bunx biome check` on the changed files                              | clean, no fixes applied                                                                                                        |
| `~/code/tscache-reports/bin/heavy-run.sh "100 child: ci" bun run ci` | recorded in the step's report to the director (a result written here would change the head it describes)                       |
| The probe of §2.3                                                    | `bunx vite build --configLoader runner --outDir <scratch>` in `examples/react-lwcharts`, four builds; `git status` clean after |
| Line references in the proposal                                      | each read at the cited lines on `2fc4308`                                                                                      |
| `docs/INDEX.md` sizes                                                | re-measured with `wc -c` after the last edit (1 KB = 1,000 bytes)                                                              |

Not verified: nothing is built, so no behaviour in the proposal is tested. The cost figures of §4.11 are reasoned from the code, not measured. The probe used one example and Vite 8.3; other bundlers were not tried. That `BroadcastChannel` and the `name` option behave as the proposal assumes in every browser with SharedWorker is taken from the platform's standards and is left to the later step's Playwright tests, which run Chromium only.
