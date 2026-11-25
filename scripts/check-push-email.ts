#!/usr/bin/env bun
/**
 * Pre-push check (step 149): refuses a push whose outgoing commits carry an
 * author or committer address that is not a GitHub noreply address (user
 * decisions #141 A and #147 A). GitHub's own check is opt-in and looks only at
 * the most recent commit's author, against the pusher's own private addresses
 * ("push declined due to email privacy restrictions"); nothing repeats this
 * check after the hook. Allowed: any address ending in
 * `@users.noreply.github.com` (the user's, a bot's such as Dependabot's, a
 * contributor's own) and exactly `noreply@github.com` (GitHub's merge
 * commits), compared case-insensitively; everything else is refused.
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
 * Limit (user decision #147 A): a commit already on another remote's tracking
 * ref is not checked when it is pushed to a different remote.
 *
 * Each line is parsed from the right: the local ref may hold spaces, the
 * remote ref any character but an ASCII space. A non-empty line that is not
 * four fields is an error (exit 1). With no non-empty line it prints that nothing
 * was checked and exits 0.
 *
 * Only the author and committer fields count; `Co-Authored-By:` trailers are
 * message text. Run by Lefthook as a `script` job (`lefthook.yml`, pre-push,
 * `use_stdin`). A manual `lefthook run pre-push` needs stdin closed
 * (`</dev/null`, docs/workflow.md): Lefthook itself waits for its stdin to
 * end before it finishes a `use_stdin` job, whatever the job reads.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** The suffix of every GitHub noreply address, `@` included. */
const NOREPLY_SUFFIX = "@users.noreply.github.com";
/** The address GitHub itself commits as, for example on merge commits. */
const GITHUB_EMAIL = "noreply@github.com";

/**
 * Whether outgoing commits may carry `email` as author or committer: an
 * address ending exactly in `@users.noreply.github.com`, or exactly
 * `noreply@github.com`, in any letter case (user decision #147 A).
 */
export function isAllowed(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.endsWith(NOREPLY_SUFFIX) || lower === GITHUB_EMAIL;
}

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
  // No output limit: a first push of a long history prints megabytes.
  return spawnSync("git", args, {
    ...options,
    encoding: "utf8",
    maxBuffer: Number.POSITIVE_INFINITY,
  });
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

/**
 * One pre-push line, `<local ref> <local sha> <remote ref> <remote sha>`,
 * matched from the right: the local ref may hold spaces (`HEAD@{1 day ago}`).
 */
const ROW = /^(.+) ([0-9a-f]{40,64}) ([^ ]+) ([0-9a-f]{40,64})$/;

interface Row {
  ref: string;
  local: string;
  remote: string;
}

/** The non-empty pre-push stdin lines, each split into its fields. */
function rowsOf(stdin: string): Row[] {
  return stdin
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map((row) => {
      const match = ROW.exec(row);
      if (match === null) {
        throw new Error(`malformed pre-push line: ${row}`);
      }
      const [, ref = "", local = "", , remote = ""] = match;
      return { ref, local, remote };
    });
}

/** One `git log` entry's fields that do not carry the allowed address. */
function offencesOf(entry: string): Offence[] {
  const [sha = "", author = "", committer = ""] = entry.split("\x1f");
  const offences: Offence[] = [];
  if (!isAllowed(author)) {
    offences.push({ sha, field: "author", email: author });
  }
  if (!isAllowed(committer)) {
    offences.push({ sha, field: "committer", email: committer });
  }
  return offences;
}

/** The offences among the commits `revisions` selects. */
function offencesIn(revisions: string[], options: GitOptions): Offence[] {
  const log = git(
    [
      "log",
      "--no-show-signature",
      "--format=%H%x1f%ae%x1f%ce",
      ...revisions,
      "--",
    ],
    options,
  );
  if (log.status !== 0) {
    const cause = log.error?.message ?? log.stderr;
    throw new Error(`git log ${revisions.join(" ")} failed: ${cause}`);
  }
  return log.stdout
    .split("\n")
    .filter((entry) => entry !== "")
    .flatMap(offencesOf);
}

/** The offences of one pushed ref. */
function rowOffences({ local, remote }: Row, options: GitOptions): Offence[] {
  const revisions = outgoing(local, remote, options);
  return revisions === undefined ? [] : offencesIn(revisions, options);
}

/** Every outgoing commit's author or committer address that is not allowed. */
export function check(stdin: string, options: GitOptions = {}): Offence[] {
  return rowsOf(stdin).flatMap((row) => rowOffences(row, options));
}

/** The branch name `git rebase` takes for a pushed local ref. */
const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

/**
 * The refusal message: each offence, then how to rewrite the commits of the
 * offending local `refs` (full ref names, as on the pre-push line).
 */
export function format(offences: Offence[], refs: string[] = []): string {
  const rows = offences.map(
    (o) => `  ${o.sha.slice(0, 12)} ${o.field} ${o.email}`,
  );
  const branches = [...new Set(refs.map(branchOf))];
  const named = branches.length > 0 ? `: ${branches.join(", ")}` : "";
  return [
    "push refused: each outgoing commit's author and committer must be a GitHub noreply address,",
    `an address ending in ${NOREPLY_SUFFIX} or exactly ${GITHUB_EMAIL}`,
    "(GitHub's opt-in check covers only the latest commit's author; nothing checks after this):",
    ...rows,
    "",
    "To fix, set your GitHub noreply address (github.com/settings/emails) and rewrite the",
    "unpushed commits, then push again:",
    `  git config user.email <you>${NOREPLY_SUFFIX}`,
    "  git rebase -r --exec 'git commit --amend --no-edit' <base> <branch>",
    "where <base> is the last pushed commit (for example origin/main) and",
    `<branch> the local branch that holds them${named}.`,
    "The amend sets you as committer and keeps each author.",
    "Use --reset-author only for author rows that are your own commits:",
    "it makes you the author of every commit in the range.",
  ].join("\n");
}

/** The hook's exit code for its stdin. */
function main(stdin: string): number {
  const rows = rowsOf(stdin);
  if (rows.length === 0) {
    console.error("check-push-email: no pre-push input; nothing checked");
    return 0;
  }
  const refs: string[] = [];
  const offences = rows.flatMap((row) => {
    const found = rowOffences(row, {});
    if (found.length > 0) refs.push(row.ref);
    return found;
  });
  if (offences.length > 0) console.error(format(offences, refs));
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
