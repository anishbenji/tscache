# Development and Review Workflow

How each step of the commit plan (starter §11) is built, tested and reviewed. Claude implements; Codex writes contract tests and reviews; the user approves and merges. Roles and hard rules are in `AGENTS.md`.

The primary driver is **T3 Code**: one Claude thread per step, plus a Codex thread for contract tests. Reviews are automated — the Claude thread runs Codex headless through `scripts/codex-review.sh` and loops review → triage → fix until every finding is settled. The fallback is the **Claude Code CLI**, which runs the same script. Both read the same repository files.

## Files that drive the agents

| File | Read by | Purpose |
|---|---|---|
| `AGENTS.md` | Codex natively; Claude through `CLAUDE.md` | Shared rules, roles, review rules |
| `CLAUDE.md` | Claude | Imports `AGENTS.md`, plus Claude-only notes |
| `.claude/settings.json` | Claude Code, and Agent SDK hosts that load project settings | Permissions, Bash guard hook, Codex plugin |
| `.claude/hooks/guard-bash.sh`, `guard-bash.ts` | Claude | Blocks `bun test` and git-hook bypasses; threat model in the `.ts` header, regression cases in `guard-bash.test.sh` |
| `.codex/config.toml` | Codex, once the project is trusted | Pins `gpt-6.1-sol` at high effort |
| `docs/review-checklist.md` | Reviewer | Invariants every review checks, and the findings format |
| `scripts/codex-review.sh` | Claude | Runs `bun run ci`, then a headless read-only Codex review (prompts C and D live here) |
| `.reviews/step-NN/` | Claude | Raw review output per round (gitignored) |
| `docs/reviews/step-NN.md` | Everyone | Findings and triage for each step |

## One-time setup

Do steps 1–2 yourself; T3 Code (a Claude thread) can do the rest with your approval.

1. **Install the Codex CLI on your `PATH`.** T3 Code and ChatGPT.app each bundle a private copy that the terminal, `scripts/codex-review.sh` and the Claude Code plugin cannot see. Use `brew install --cask codex` (native binary) or `bun add -g @openai/codex` (Node launcher; needs `node` on `PATH`). Check with `codex --version`; sign in with ChatGPT on first run if asked.
2. **Trust the project in Codex** so `.codex/config.toml` loads. Untrusted projects ignore the project `.codex/` directory, and T3 Code may never show the prompt. In a terminal: `cd ~/code/tscache && codex`, choose **Trust and continue**, then quit. Codex records this in `~/.codex/config.toml` as `[projects."<repo path>"]` with `trust_level = "trusted"`; check with `grep -A1 'code/tscache' ~/.codex/config.toml`.
3. **Toolchain:** Node ≥ 22.12, Bun and `gitleaks` (`brew install gitleaks`) must be on `PATH` — Lefthook and `scripts/ci.sh` call `gitleaks` directly. Fallow is a pinned devDependency (`bun run fallow`), installed by `bun install`.
4. **Git hooks** are installed by Lefthook. If they go missing: `bunx lefthook install`. Exercise the pre-push set without pushing: `bunx lefthook run pre-push`.
5. **Codex plugin for the Claude Code CLI (fallback only):** `claude plugin marketplace add openai/codex-plugin-cc`, then `claude plugin install codex@openai-codex`; confirm with `claude plugin list`, then run `/codex:setup` once inside Claude Code.
6. **Before step ⑨** (first browser tests): `bunx playwright install chromium`.
7. **T3 Code:** open threads at the repository root. Check that Codex threads offer GPT-6.1 Sol and that Claude threads load the project settings — asking a Claude thread to run `bun test --help` must be blocked. If it runs, T3 is not loading `.claude/settings.json`; the rule still applies through `AGENTS.md`.
8. **Final check:** `bun run ci` passes.

## Per-step loop

| # | Who | Action | Engine steps ③–⑧ | Other steps |
|---|---|---|---|---|
| 0 | You | `git switch -c feat/NN-slug main` | ✓ | ✓ |
| 1 | Codex thread | Contract tests — prompt A. Leave uncommitted. | ✓ | — |
| 2 | Claude thread | Implement — prompt B | ✓ | ✓ |
| 3 | Claude thread | Review loop — prompt E (below) | ✓ | ✓ |
| 4 | You | Read `docs/reviews/step-NN.md`, run `bun run ci`, `git switch main && git merge --no-ff feat/NN-slug` | ✓ | ✓ |

Keep tooling off step branches. Changes to hooks, scripts, agent configuration or this workflow go on their own `chore/NN-slug` branch from `main` with their own review loop, so a step review covers only the step's code.

## Review loop

The reviewer reads only committed history (`git diff main...feat/NN-slug`), so commit before each round.

1. **Review.** `scripts/codex-review.sh NN`. The script runs `bun run ci` on the host (Codex's read-only sandbox cannot install or build), then runs `codex exec` read-only in a fresh session with prompt C and the CI result. The model comes from `.codex/config.toml`; the script sets effort high. Output: `.reviews/step-NN/round-K.md`.
2. **Adversarial review**, for steps in the schedule below: `scripts/codex-review.sh NN --adversarial "<focus>"` (effort xhigh). Output: `.reviews/step-NN/adversarial-K.md`.
3. **Validate every finding** before acting on it: reproduce it with a failing test, or confirm it by reading the code and the cited doc section. A finding that does not survive validation is rejected with the evidence.
4. **Triage.** Accepted findings are fixed in small commits, test first where behaviour changes. Rejections take one sentence citing the doc section. "Decision concerns" are never acted on — they go to the user. Record the round in `docs/reviews/step-NN.md` and commit it as `docs(review): step NN round K triage`.
5. **Re-review** when the round had a P0 or P1, accepted or contested. Run the script again. Later rounds read the triage file, check that accepted fixes landed, and may contest a rejection with a reason.
6. **Settled** when a round reports no P0 or P1, new or re-raised. That round's P2s and nits are still triaged (fixed or rejected) but do not trigger another round. A re-raised rejection that the triage answers with a doc citation does not block settling.
7. **Convergence check.** If the same area draws findings in two consecutive rounds, the fixes are not converging: stop patching, then redesign the area or escalate to the user, and record which in the triage. More rounds on a design that keeps leaking only produce more patches.
8. **Cap.** Stop after four rounds without settling and escalate to the user.

The Claude thread runs the loop without stopping between rounds, then reports the final triage to the user. Each round uses a fresh Codex session, so the reviewer carries no context from writing the contract tests or from earlier rounds beyond the triage file.

## Prompts

Replace `NN`, `<name>`, `<modules>` and `feat/NN-slug` before sending. Prompts C (review) and D (adversarial review) are generated by `scripts/codex-review.sh`; print one with `--print-prompt` to paste into a Codex thread by hand.

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

**E — Review loop (Claude)**

```text
Run the review loop in docs/workflow.md for step NN on feat/NN-slug[, with an adversarial pass focused on <focus>].
Validate every finding before fixing it, write docs/reviews/step-NN.md using the template in docs/reviews/README.md, and re-review until all findings are settled.
Do not act on "Decision concerns" — list them for me.
```

### Claude Code CLI equivalents

The CLI runs prompts B and E and the review script exactly as T3 Code does. The Codex plugin is an alternative for one-off reviews:

| Purpose | CLI |
|---|---|
| Contract tests (A) | `/codex:rescue --fresh --background <prompt A>` |
| One-off review | `/codex:review --base main --background` (not steerable; Codex applies the `AGENTS.md` review rules) |
| One-off adversarial review | `/codex:adversarial-review --base main --background <focus>` |
| Collect output | `/codex:status`, `/codex:result` |

Never enable the plugin's review gate; it loops Claude and Codex and drains usage. The review loop above replaces it.

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
- **Codex:** GPT-6.1 Sol at high effort for prompts A and C; xhigh for prompt D (the review script sets this). Avoid Ultrafast for reviews: it uses the subscription limit about 8× faster.
