# Development and Review Workflow

How each step of the commit plan (starter §11) is built, tested and reviewed. Claude implements; Codex writes contract tests and reviews; the user approves and merges. Roles and hard rules are in `AGENTS.md`.

The primary driver is **T3 Code**, with one Claude thread and separate Codex threads per step. The fallback is the **Claude Code CLI** with the Codex plugin. Both read the same repository files, so switching between them changes nothing below except how the prompts are sent.

## Files that drive the agents

| File | Read by | Purpose |
|---|---|---|
| `AGENTS.md` | Codex natively; Claude through `CLAUDE.md` | Shared rules, roles, review rules |
| `CLAUDE.md` | Claude | Imports `AGENTS.md`, plus Claude-only notes |
| `.claude/settings.json` | Claude Code, and Agent SDK hosts that load project settings | Permissions, Bash guard hook, Codex plugin |
| `.claude/hooks/guard-bash.sh` | Claude | Blocks `bun test` and git-hook bypasses |
| `.codex/config.toml` | Codex, once the project is trusted | Pins `gpt-6.1-sol` at high effort |
| `docs/review-checklist.md` | Reviewer | Invariants every review checks, and the findings format |
| `docs/reviews/step-NN.md` | Everyone | Findings and triage for each step |

## One-time setup

1. **Trust the project in Codex** so `.codex/config.toml` loads: accept the trust prompt the first time Codex opens this repository. Untrusted projects ignore the project `.codex/` directory.
2. **Git hooks** are already installed by Lefthook. If they go missing: `bunx lefthook install`.
3. **T3 Code:** check that Codex threads offer GPT-6.1 Sol, and that Claude threads pick up `CLAUDE.md` (ask the thread to quote the first rule in `AGENTS.md`). If T3 does not load project settings, the guard hook will not run there; the rule still applies through `AGENTS.md`.
4. **Claude Code CLI (fallback only):** on first launch in this repository, accept the prompt to install the `openai-codex` marketplace and `codex` plugin, then run `/codex:setup`.

## Per-step loop

| # | Who | Action | Engine steps ③–⑧ | Other steps |
|---|---|---|---|---|
| 0 | You | `git switch -c feat/NN-slug main` | ✓ | ✓ |
| 1 | Codex thread | Contract tests — prompt A. Leave uncommitted. | ✓ | — |
| 2 | Claude thread | Implement — prompt B | ✓ | ✓ |
| 3 | **New** Codex thread | Review — prompt C | ✓ | ✓ |
| 3b | Same thread as 3 | Adversarial review — prompt D, effort xhigh | per schedule | per schedule |
| 4 | Claude thread | Triage — prompt E | ✓ | ✓ |
| 5 | Codex thread from 3 | Re-review the fix commits, only if P0/P1 fixes were substantial | as needed | as needed |
| 6 | You | Read `docs/reviews/step-NN.md`, run `bun run ci`, `git switch main && git merge --no-ff feat/NN-slug` | ✓ | ✓ |

The reviewer runs in a fresh thread so it carries no context from writing the contract tests. Prompts name the branch explicitly, so they work even if T3 Code gives each thread its own worktree.

## Prompts

Replace `NN`, `<name>`, `<modules>` and `feat/NN-slug` before sending.

**A — Contract tests (Codex, engine steps only)**

```text
You are the contract-test author for step NN (<name>) of the commit plan in starter-prompt.md §11 (see AGENTS.md → Roles).
Read docs/architecture.md (§2, §4, §5 and every decision row that touches this step) and starter-prompt.md §3.
Write failing Vitest tests in packages/tscache/test/ that pin the specified behaviour of <modules>, importing from the paths in architecture §4. Cover happy paths, every documented rejection, fenceposts (inclusive ends, single-slot ranges, snap-outward, segment slot cap, gap exactly K vs K+1), and property-style checks where the doc asks for them.
Test the contract, not an implementation: no assertions on private helpers or internal layout the doc does not specify.
Do not create or edit anything under src/. Do not add dependencies; if a property test needs a library, say so instead. Do not commit.
Finish with a table of each test and the doc section it enforces, then any spec ambiguities you hit. Do not resolve ambiguities yourself.
```

**B — Implement (Claude)**

```text
Implement step NN (<name>) per starter-prompt.md §11 and docs/architecture.md on branch feat/NN-slug.
[Engine steps:] Codex's contract tests are in the working tree. Make them pass without weakening them; if one looks wrong, stop and tell me which and why.
Small Conventional Commits, `bun run ci` green after each; contract tests go in the same commit as the code that makes them pass.
```

**C — Review (Codex, new thread)**

```text
Read-only code review. Do not edit, create, stage or commit anything.
Review `git diff main...feat/NN-slug` and `git log main..feat/NN-slug` — step NN (<name>) of starter-prompt.md §11.
Check the diff against docs/review-checklist.md, docs/architecture.md and AGENTS.md. Run `bun run ci` and report the result.
Report findings in the checklist's output format, most severe first, then the verdict. Only report issues tied to a line and a concrete failure scenario.
```

**D — Adversarial review (Codex, same thread as C, effort xhigh)**

```text
Now an adversarial pass on the same diff, still read-only.
Challenge the approach, not just the code: hidden assumptions, failure modes, and whether a simpler design within the locked decisions would be safer. Focus: <focus from the schedule below>.
Locked decisions (starter §3, architecture §7–§8) are not findings. If you think one is wrong, put it under "Decision concerns".
Use the output format in docs/review-checklist.md.
```

**E — Triage (Claude)**

```text
Codex's review of step NN is below. For each finding, accept it (fix it) or reject it (one sentence citing the doc section).
Write docs/reviews/step-NN.md using the template in docs/reviews/README.md, fix accepted findings in small commits, and commit the triage file as `docs(review): step NN triage`.
Do not act on "Decision concerns" — list them for me.

<paste review>
```

### Claude Code CLI equivalents

| Prompt | CLI |
|---|---|
| A | `/codex:rescue --fresh --background <prompt A>` |
| B, E | Send to Claude directly |
| C | `/codex:review --base main --background` (not steerable; Codex applies the `AGENTS.md` review rules) |
| D | `/codex:adversarial-review --base main --background <focus>` |
| — | `/codex:status`, `/codex:result` to collect output; paste into prompt E |

Never enable the plugin's review gate; it loops Claude and Codex and drains usage.

## Adversarial-review schedule

| Step | Focus |
|---|---|
| ③ Coverage index | Inclusive-range fenceposts and snap-outward; ms↔slot conversion confined to one site; merge and subtraction on adjacent, touching and nested ranges |
| ⑤ Merge / put path | Atomic reject leaves no partial state; new-wins across segment boundaries; K-split and slot-cap edges; overlap-warning cost when off |
| ⑦ Invalidation suite | Volatile region never gaining authority; watermark moving backwards; version-mismatch clear racing a put |
| ⑨ RPC + handshake | Cache-owned buffers never transferred; mismatch handling; payload still valid for IndexedDB and SSR |
| ⑩ SharedWorker + fallback | Fallback order and pinning; tab death; the no-SharedWorker (Chrome Android) path |
| ⑪ Fetcher orchestration | Dedup keying, flank coalescing, `authInvalid`/`updateAuth` races, `get` never blocking on auth |
| ⑫ Playwright suite | Tests passing for the wrong reason (pages vs contexts), flakiness, timing assumptions |

## Model choice

- **Claude threads:** Opus 5.5 by default. Consider Fable 5.1 for steps ⑨–⑪ if your plan covers it — on Max plans it can use up to 50% of the weekly limit at no extra cost; on Pro it needs usage credits.
- **Codex threads:** GPT-6.1 Sol at high effort for prompts A and C; xhigh for prompt D. Avoid Ultrafast for reviews: it uses the subscription limit about 8× faster.
