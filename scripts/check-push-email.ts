#!/usr/bin/env bun
/**
 * Pre-push check (step 149): refuses a push whose outgoing commits carry an
 * author or committer address, or whose pushed annotated tags carry a tagger
 * address, that is not a GitHub noreply address (user decisions #141 A, #147 A
 * and #153 A). GitHub's own check is opt-in, ignores tags and looks only at
 * the most recent commit's author, against the pusher's own private addresses
 * ("push declined due to email privacy restrictions"); nothing repeats this
 * check after the hook. Allowed: a well-formed address ending in
 * `@users.noreply.github.com` (the user's, a bot's such as Dependabot's, a
 * contributor's own) and exactly `noreply@github.com` (GitHub's merge
 * commits), compared case-insensitively; everything else is refused
 * (decision #154 A: a well-formed address has one `@` and no whitespace,
 * control character, `<` or `>`).
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
 * Each line is split at its last three ASCII spaces (decision #154 A): the
 * local ref before them may hold any character and is not used. A non-empty
 * line whose last three fields are not a sha, a non-empty remote ref and a sha
 * is an error (exit 1). With no non-empty line it prints that nothing was
 * checked and exits 0.
 *
 * `git log` runs NUL-framed (`-z`, fields split by NUL) in UTF-8 whatever
 * `i18n.logOutputEncoding` says: git cannot store a NUL in an address, so no
 * byte inside one can shift the fields, and output of the wrong shape is an
 * error (exit 1).
 *
 * The refusal lists each offence (sha, field, address) and then fixed advice
 * that names no ref; the common branch case is in docs/workflow.md.
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
 * A GitHub noreply address: a local part with no `@`, whitespace, `<` or
 * `>`, then the suffix, to the end of the string. Control characters are
 * refused by {@link hasControl}; Biome forbids them in a regular expression.
 */
const NOREPLY = /^[^\s@<>]+@users\.noreply\.github\.com$/i;

/** Whether `text` holds an ASCII control character (U+0000–U+001F, U+007F). */
const hasControl = (text: string) =>
  [...text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

/**
 * Whether outgoing commits and tags may carry `email` as author, committer
 * or tagger: a well-formed address ending in `@users.noreply.github.com`, or
 * exactly `noreply@github.com`, in any letter case (user decision #147 A,
 * the well-formed rule from decision #154 A).
 */
export function isAllowed(email: string): boolean {
  if (NOREPLY.test(email)) return !hasControl(email);
  return email.toLowerCase() === GITHUB_EMAIL;
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

/** A full object name, SHA-1 or SHA-256. */
const SHA = /^[0-9a-f]{40,64}$/;

interface Row {
  local: string;
  remote: string;
}

/**
 * One pre-push line, `<local ref> <local sha> <remote ref> <remote sha>`,
 * split at its last three spaces; the local ref (any characters, spaces
 * included, as in `HEAD@{1 day ago}`) is not used.
 */
function rowOf(row: string): Row {
  const third = row.lastIndexOf(" ");
  const second = third > 0 ? row.lastIndexOf(" ", third - 1) : -1;
  const first = second > 0 ? row.lastIndexOf(" ", second - 1) : -1;
  const local = row.slice(first + 1, second);
  const remoteRef = row.slice(second + 1, third);
  const remote = row.slice(third + 1);
  if (first < 0 || !SHA.test(local) || remoteRef === "" || !SHA.test(remote)) {
    throw new Error(`malformed pre-push line: ${row}`);
  }
  return { local, remote };
}

/** The non-empty pre-push stdin lines, each split into its fields. */
function rowsOf(stdin: string): Row[] {
  return stdin
    .split("\n")
    .filter((row) => row.trim() !== "")
    .map(rowOf);
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

/** One commit's fields that do not carry an allowed address. */
function offencesOf(sha: string, author: string, committer: string): Offence[] {
  const offences: Offence[] = [];
  if (!isAllowed(author)) {
    offences.push({ sha, field: "author", email: author });
  }
  if (!isAllowed(committer)) {
    offences.push({ sha, field: "committer", email: committer });
  }
  return offences;
}

/**
 * The offences in NUL-framed `git log` output, `<sha> NUL <author> NUL
 * <committer> NUL` per commit; any other shape is an error.
 */
function offencesInLog(stdout: string): Offence[] {
  const fields = stdout.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0) {
    throw new Error("git log printed output of an unexpected shape");
  }
  const offences: Offence[] = [];
  for (let i = 0; i < fields.length; i += 3) {
    const [sha = "", author = "", committer = ""] = fields.slice(i, i + 3);
    if (!SHA.test(sha)) {
      throw new Error(`git log printed an unexpected commit name: ${sha}`);
    }
    offences.push(...offencesOf(sha, author, committer));
  }
  return offences;
}

/** The offences among the commits `revisions` selects. */
function offencesIn(revisions: string[], options: GitOptions): Offence[] {
  const log = git(
    [
      "log",
      "-z",
      "--encoding=UTF-8",
      "--no-show-signature",
      "--format=%H%x00%ae%x00%ce",
      ...revisions,
      "--",
    ],
    options,
  );
  if (log.status !== 0) {
    const cause = log.error?.message ?? log.stderr;
    throw new Error(`git log ${revisions.join(" ")} failed: ${cause}`);
  }
  return offencesInLog(log.stdout);
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

/**
 * What to do about a refusal, the same for every offence (decision #154 A):
 * no ref name and no per-ref command, which no single recipe gets right for
 * every kind of pushed ref.
 */
const ADVICE = [
  "",
  "To fix, set your GitHub noreply address (github.com/settings/emails):",
  `  git config user.email <you>${NOREPLY_SUFFIX}`,
  "Rewrite the listed commits, or re-create the listed tags, with that address, then push again.",
  "Never rewrite a commit or tag that is already pushed: others may have fetched it.",
  'For the common case, a branch: docs/workflow.md, "One-time setup", item 4 (Git hooks).',
];

/** The refusal message: the rule, each offence, then the fixed advice. */
export function format(offences: Offence[]): string {
  const rows = offences.map(
    (o) =>
      `  ${o.sha.slice(0, 12)} ${o.field} ${o.email}` +
      (o.tag === undefined ? "" : ` (tag ${o.tag})`),
  );
  return [
    "push refused: each outgoing commit's author and committer, and each pushed tag's tagger,",
    "must be a GitHub noreply address,",
    `an address ending in ${NOREPLY_SUFFIX} or exactly ${GITHUB_EMAIL}`,
    "(one @, no whitespace, control character, < or >;",
    "GitHub's opt-in check covers only the latest commit's author; nothing checks after this):",
    ...rows,
    ...ADVICE,
  ].join("\n");
}

/** The hook's exit code for its stdin. */
function main(stdin: string): number {
  const rows = rowsOf(stdin);
  if (rows.length === 0) {
    console.error("check-push-email: no pre-push input; nothing checked");
    return 0;
  }
  const offences = rows.flatMap((row) => rowOffences(row, {}));
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
