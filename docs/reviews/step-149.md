# Step 149 — a pre-push check for the commit address

Branch: `chore/149-push-email-check` · Reviewer: the director's review ladder · Rounds: 0 · Status: awaiting review · Verdict after triage: —

## Scope

GitHub declines pushes of commits that carry the user's private address ("push declined due to email privacy restrictions", 2026-11-25). The repository's `user.email` is `anishbenji@users.noreply.github.com` (user decision #141 A). This step adds a pre-push check that refuses a push when an outgoing commit carries any other author or committer address, so the mistake is caught locally before GitHub rejects the push. `lefthook.yml` is a protected path; the edit is user-approved (2026-11-25).

## What changed

- `scripts/check-push-email.ts` reads git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line) and lists the outgoing commits of each pushed ref: `<remote sha>..<local sha>` for an existing remote ref; `<local sha> --not --remotes` for a new remote ref (remote sha all zeros), and also when the remote sha is not in this clone, where the range form would fail; nothing for a deleted ref (local sha all zeros). Each commit's `%ae` and `%ce` must equal `ALLOWED_EMAIL`, the one constant holding the address. On a mismatch it prints each offending commit (12-character hash, `author` or `committer`, the address) and how to re-author the unpushed commits, then exits 1. `Co-Authored-By:` trailers are message text and are not read. When stdin is a terminal (`bunx lefthook run pre-push --force` by hand, as `docs/workflow.md` suggests) there is no push input, so it prints that it skipped and exits 0 instead of waiting on the terminal.
- `lefthook.yml`: the `pre-push` hook is now `piped: true` with two jobs: `push-email` (`bun scripts/check-push-email.ts`, `use_stdin: true`) first, then a `checks` group with `parallel: true` holding the previous jobs unchanged. Lefthook's documentation says only one job receives stdin and that a job that reads it needs `use_stdin`; running the check first and alone gives it stdin, and the piped top level skips the heavy checks when it fails.
- `scripts/check-push-email.test.ts` builds a throwaway repository per test in a temporary directory, with remote-tracking refs written by `git update-ref` (no remote, no network), and calls the check with the stdin git would give. It strips the surrounding `GIT_*` variables (a hook's `GIT_DIR` would otherwise point the commands at this repository) and the global and system config. Covered: an existing branch with good commits passes; another author address, another committer address, and both are refused with the right field; commits before the remote sha are not checked; a new branch checks only commits on no remote-tracking ref, and every commit when there is none; an unknown remote sha falls back to the new-branch range; a deleted ref checks nothing; a `Co-Authored-By:` trailer with another address passes; several refs at once and empty stdin; the message format; and the script run as `bun scripts/check-push-email.ts` exits 1 naming the commit and 0 when clean. The describe block has a 30-second limit: each test spawns about ten git processes, which took up to 5.8 s for one test under a load average of 13; no assertion reads time.
- `AGENTS.md` (Toolchain hard rules, hook staging): the pre-push list names the check first.

Not changed: `scripts/ci.sh`, `.github/` and the root `package.json` scripts (outside this step's scope). CI does not run the check; see the report for whether it should.

## Verification

- `bunx vitest run scripts/check-push-email.test.ts`: 13 tests pass.
- `bun scripts/test-clocks.ts`: clean.
- Lefthook end to end, in a throwaway repository with the same hook layout and a stand-in heavy job, the pre-push line piped into `lefthook run pre-push --force`: a clean range runs both jobs and exits 0; a commit by `someone@example.com` prints the refusal for its author and committer, skips the `checks` group and exits 1. From a pseudo-terminal with no push input, the check prints that it skipped and the group runs.

## Decision concerns

None.
