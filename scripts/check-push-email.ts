#!/usr/bin/env bun
/**
 * Pre-push check (step 149): refuses a push whose outgoing commits carry an
 * author or committer address, or whose pushed annotated tags carry a tagger
 * address, that is not a GitHub noreply address (user decisions #141 A, #147 A
 * and #153 A). GitHub's own check is opt-in, ignores tags and looks only at
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
 * When `<local sha>` is an annotated tag object, the tagger of that tag, and of
 * each tag it names in turn (a tag of a tag), is checked as well; a tag object
 * with no tagger line is refused. A lightweight tag is no object of its own and
 * is checked as the commits it names.
 *
 * Every git call runs with `--no-replace-objects`: a replace ref (`git
 * replace`) changes only the local view, and git pushes the original objects.
 *
 * Limit (user decision #147 A): a commit already on another remote's tracking
 * ref is not checked when it is pushed to a different remote.
 *
 * Each line is parsed from the right: the local ref may hold spaces, the
 * remote ref any character but an ASCII space. A non-empty line that is not
 * four fields is an error (exit 1). With no non-empty line it prints that nothing
 * was checked and exits 0.
 *
 * Only the author, committer and tagger fields count; `Co-Authored-By:` trailers are
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
 * Whether outgoing commits and tags may carry `email` as author, committer
 * or tagger: an
 * address ending exactly in `@users.noreply.github.com`, or exactly
 * `noreply@github.com`, in any letter case (user decision #147 A).
 */
export function isAllowed(email: string): boolean {
  const lower = email.toLowerCase();
  return lower.endsWith(NOREPLY_SUFFIX) || lower === GITHUB_EMAIL;
}

export interface Offence {
  sha: string;
  field: "author" | "committer" | "tagger";
  email: string;
  /** For a tagger row, the tag's name as its tag object records it. */
  tag?: string;
}

interface GitOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

const ZERO = /^0+$/;

function git(args: string[], options: GitOptions) {
  // No output limit: a first push of a long history prints megabytes.
  // No replace refs: they change the local view, not the objects pushed.
  return spawnSync("git", ["--no-replace-objects", ...args], {
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

/** The type of the object `sha` names, or undefined when git cannot read it. */
function typeOf(sha: string, options: GitOptions): string | undefined {
  const result = git(["cat-file", "-t", sha], options);
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The header fields of the tag object `sha` (`object`, `type`, `tag`,
 * `tagger`); the header ends at the first empty line, and a continuation line
 * (a leading space) is not a field.
 */
function tagHeader(sha: string, options: GitOptions): Map<string, string> {
  const raw = git(["cat-file", "tag", sha], options);
  if (raw.status !== 0) {
    const cause = raw.error?.message ?? raw.stderr;
    throw new Error(`git cat-file tag ${sha} failed: ${cause}`);
  }
  const header = new Map<string, string>();
  for (const row of raw.stdout.split("\n")) {
    if (row === "") break;
    const space = row.indexOf(" ");
    if (space > 0) header.set(row.slice(0, space), row.slice(space + 1));
  }
  return header;
}

/** The address in an identity, `Name <address> <time> <zone>`, or "" without one. */
const addressOf = (identity = "") => /<([^>]*)>/.exec(identity)?.[1] ?? "";

/**
 * The tagger offences of `sha` when it is an annotated tag: its own, then
 * those of each tag it names in turn, down to the first object that is not a
 * tag. Anything else, or an object git cannot read, has none here; `git log`
 * then reads the commits, or fails.
 */
function tagOffences(sha: string, options: GitOptions): Offence[] {
  const offences: Offence[] = [];
  let current: string | undefined = sha;
  while (current !== undefined && typeOf(current, options) === "tag") {
    const header = tagHeader(current, options);
    const email = addressOf(header.get("tagger"));
    if (!isAllowed(email)) {
      offences.push({
        sha: current,
        field: "tagger",
        email,
        tag: header.get("tag") ?? "",
      });
    }
    current = header.get("object");
  }
  return offences;
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
  if (revisions === undefined) return [];
  return [...tagOffences(local, options), ...offencesIn(revisions, options)];
}

/**
 * Every outgoing commit's author or committer address, and every pushed
 * annotated tag's tagger address, that is not allowed.
 */
export function check(stdin: string, options: GitOptions = {}): Offence[] {
  return rowsOf(stdin).flatMap((row) => rowOffences(row, options));
}

/** The branch name `git rebase` takes for a pushed local ref. */
const branchOf = (ref: string) => ref.replace(/^refs\/heads\//, "");

/** How to rewrite the offending commits of the local `refs`. */
function commitAdvice(refs: string[]): string[] {
  const branches = [...new Set(refs.map(branchOf))];
  const named = branches.length > 0 ? `: ${branches.join(", ")}` : "";
  return [
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
  ];
}

/** How to re-create an offending annotated tag before it is pushed. */
const TAG_ADVICE = [
  "",
  "For a tagger row, set your GitHub noreply address and re-create the tag on the",
  "object it names (git opens an editor for its message), then push again:",
  `  git config user.email <you>${NOREPLY_SUFFIX}`,
  "  git tag -f -a <tag> <tag>^{}",
  "Never re-create a tag that is already pushed: others may have fetched it.",
];

/**
 * The refusal message: each offence, then how to rewrite the commits of the
 * offending local `refs` (full ref names, as on the pre-push line) when a
 * commit is refused, and how to re-create a tag when a tagger is refused.
 */
export function format(offences: Offence[], refs: string[] = []): string {
  const rows = offences.map(
    (o) =>
      `  ${o.sha.slice(0, 12)} ${o.field} ${o.email}` +
      (o.tag === undefined ? "" : ` (tag ${o.tag})`),
  );
  const commits = offences.some((o) => o.field !== "tagger");
  const tags = offences.some((o) => o.field === "tagger");
  return [
    "push refused: each outgoing commit's author and committer, and each pushed tag's tagger,",
    "must be a GitHub noreply address,",
    `an address ending in ${NOREPLY_SUFFIX} or exactly ${GITHUB_EMAIL}`,
    "(GitHub's opt-in check covers only the latest commit's author; nothing checks after this):",
    ...rows,
    ...(commits ? commitAdvice(refs) : []),
    ...(tags ? TAG_ADVICE : []),
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
    if (found.some((o) => o.field !== "tagger")) refs.push(row.ref);
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
