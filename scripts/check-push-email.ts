#!/usr/bin/env bun
/**
 * Pre-push check (step 149): refuses a push whose outgoing commits carry an
 * author or committer address other than the repository's noreply address.
 * GitHub declines such pushes ("push declined due to email privacy
 * restrictions"); this catches them locally first (user decision #141 A).
 *
 * Reads git's pre-push stdin, one `<local ref> <local sha> <remote ref>
 * <remote sha>` line per pushed ref, and checks for each:
 * - an existing remote ref: the commits of `<local sha>` on neither that
 *   ref nor any remote-tracking ref (`<local sha> --not <remote sha>
 *   --remotes`), so commits merged in from, say, `origin/main` are not
 *   checked again;
 * - a new remote ref (remote sha all zeros), or a remote sha this clone does
 *   not have: the commits of `<local sha>` on no remote-tracking ref
 *   (`<local sha> --not --remotes`);
 * - a deleted ref (local sha all zeros): nothing.
 *
 * A non-empty line that is not four fields is an error (exit 1). With no
 * non-empty line it prints that nothing was checked and exits 0.
 *
 * Only the author and committer fields count; `Co-Authored-By:` trailers are
 * message text. Run by Lefthook as a `script` job (`lefthook.yml`, pre-push,
 * `use_stdin`). A manual `lefthook run pre-push` needs stdin closed
 * (`</dev/null`, docs/workflow.md): Lefthook itself waits for its stdin to
 * end before it finishes a `use_stdin` job, whatever the job reads.
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
    return [local, "--not", remote, "--remotes"];
  }
  return [local, "--not", "--remotes"];
}

/** The non-empty pre-push stdin lines, each split into its four fields. */
function rowsOf(stdin: string): string[][] {
  return stdin
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row !== "")
    .map((row) => {
      const fields = row.split(/\s+/);
      if (fields.length !== 4) {
        throw new Error(`malformed pre-push line: ${row}`);
      }
      return fields;
    });
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
  return rowsOf(stdin).flatMap(([, local = "", , remote = ""]) => {
    const revisions = outgoing(local, remote, options);
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

/** The hook's exit code for its stdin. */
function main(stdin: string): number {
  if (rowsOf(stdin).length === 0) {
    console.error("check-push-email: no pre-push input; nothing checked");
    return 0;
  }
  const offences = check(stdin);
  if (offences.length > 0) console.error(format(offences));
  return offences.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  try {
    process.exit(main(readFileSync(0, "utf8")));
  } catch (error) {
    console.error(`check-push-email: ${(error as Error).message}`);
    process.exit(1);
  }
}
