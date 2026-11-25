/**
 * Pre-push check (step 149): refuses a push whose outgoing commits carry an
 * author or committer address other than the repository's noreply address.
 * GitHub declines such pushes ("push declined due to email privacy
 * restrictions"); this catches them locally first (user decision #141 A).
 *
 * Reads git's pre-push stdin, one `<local ref> <local sha> <remote ref>
 * <remote sha>` line per pushed ref, and checks for each:
 * - an existing remote ref: `<remote sha>..<local sha>`;
 * - a new remote ref (remote sha all zeros), or a remote sha this clone does
 *   not have: the commits of `<local sha>` on no remote-tracking ref
 *   (`<local sha> --not --remotes`);
 * - a deleted ref (local sha all zeros): nothing.
 *
 * Only the author and committer fields count; `Co-Authored-By:` trailers are
 * message text. Run by Lefthook (`lefthook.yml`, pre-push, `use_stdin`).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The one address outgoing commits may carry as author and committer. */
export const ALLOWED_EMAIL = "anishbenji@users.noreply.github.com";

export interface Offence {
  sha: string;
  field: "author" | "committer";
  email: string;
}

interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const ZERO = /^0+$/;

function git(args: string[], options: GitOptions) {
  return spawnSync("git", args, { ...options, encoding: "utf8" });
}

function isCommit(sha: string, options: GitOptions): boolean {
  return git(["cat-file", "-e", `${sha}^{commit}`], options).status === 0;
}

/** The `git log` revision arguments for one pre-push line, or none. */
function outgoing(local: string, remote: string, options: GitOptions) {
  if (ZERO.test(local)) return undefined;
  if (!ZERO.test(remote) && isCommit(remote, options)) {
    return [`${remote}..${local}`];
  }
  return [local, "--not", "--remotes"];
}

/** The revision arguments for one pre-push stdin line, or none. */
function revisionsOf(row: string, options: GitOptions) {
  const [, local, , remote] = row.trim().split(/\s+/);
  if (local === undefined || remote === undefined) return undefined;
  return outgoing(local, remote, options);
}

/** One `git log` entry's fields that do not carry the allowed address. */
function offencesOf(entry: string): Offence[] {
  const [sha = "", author = "", committer = ""] = entry.split("\x1f");
  const offences: Offence[] = [];
  if (author !== ALLOWED_EMAIL) {
    offences.push({ sha, field: "author", email: author });
  }
  if (committer !== ALLOWED_EMAIL) {
    offences.push({ sha, field: "committer", email: committer });
  }
  return offences;
}

/** The offences among the commits `revisions` selects. */
function offencesIn(revisions: string[], options: GitOptions): Offence[] {
  const log = git(
    ["log", "--format=%H%x1f%ae%x1f%ce", ...revisions, "--"],
    options,
  );
  if (log.status !== 0) {
    throw new Error(`git log ${revisions.join(" ")} failed: ${log.stderr}`);
  }
  return log.stdout
    .split("\n")
    .filter((entry) => entry !== "")
    .flatMap(offencesOf);
}

/** Every outgoing commit's author or committer address that is not allowed. */
export function check(stdin: string, options: GitOptions = {}): Offence[] {
  return stdin.split("\n").flatMap((row) => {
    const revisions = revisionsOf(row, options);
    return revisions === undefined ? [] : offencesIn(revisions, options);
  });
}

/** The refusal message: each offence, then how to re-author the commits. */
export function format(offences: Offence[]): string {
  const rows = offences.map(
    (o) => `  ${o.sha.slice(0, 12)} ${o.field} ${o.email}`,
  );
  return [
    `push refused: outgoing commits must use ${ALLOWED_EMAIL} as author and committer`,
    "(GitHub declines pushes of commits that carry a private address):",
    ...rows,
    "",
    "To fix, set the address and re-author the unpushed commits, then push again:",
    `  git config user.email ${ALLOWED_EMAIL}`,
    "  git rebase -r --exec 'git commit --amend --no-edit --reset-author' <base>",
    "where <base> is the last pushed commit (for example origin/main).",
  ].join("\n");
}

if (import.meta.main) {
  // A terminal on stdin means no push is under way (`lefthook run pre-push`
  // by hand, docs/workflow.md): there is no input to wait for.
  if (process.stdin.isTTY) {
    console.error("check-push-email: no pre-push input on stdin; skipped");
    process.exit(0);
  }
  const offences = check(readFileSync(0, "utf8"));
  if (offences.length > 0) {
    console.error(format(offences));
    process.exit(1);
  }
}
