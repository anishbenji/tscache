#!/usr/bin/env bun
/**
 * Pre-push check (step 149): refuses a push that carries an address that is
 * not a GitHub noreply address in any of the identities it checks: each
 * outgoing commit's author and committer, the tagger of each pushed annotated
 * tag, and the tagger of each signed tag a merge commit embeds (user
 * decisions #141 A, #147 A, #153 A and #155 A). GitHub's own check is opt-in, ignores tags and looks only at
 * the most recent commit's author, against the pusher's own private addresses
 * ("push declined due to email privacy restrictions"); nothing repeats this
 * check after the hook. Allowed: a well-formed address ending in
 * `@users.noreply.github.com` (the user's, a bot's such as Dependabot's, a
 * contributor's own) and exactly `noreply@github.com` (GitHub's merge
 * commits), compared case-insensitively; everything else is refused
 * (decision #154 A: a well-formed address has one `@` and no whitespace,
 * control character, `<` or `>`).
 *
 * Threat model: the check guards against the maintainer or an agent publishing
 * a private address by accident. It is no defence against someone hiding one
 * on purpose: anyone with push access can skip hooks (the agents' guard blocks
 * that for agents; the maintainer can). An escape that needs a deliberately
 * built commit (an odd encoding, control bytes, a hand-made header) is a limit,
 * graded P3 at most, not a blocker.
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
 * Limits under the threat model, not fixed:
 * - A local source expression that holds a newline (a revision built that way
 *   on purpose, such as `HEAD@{0<newline>seconds ago}`) splits its pre-push
 *   row, and the push is refused as malformed, never let through.
 * - For an annotated tag that points at a blob, the blob is read whole
 *   before the hook sees it is no tag and has no tagger: a large blob makes
 *   the push slow and memory-hungry; nothing is let through.
 *
 * Each line is split at its last three ASCII spaces (decision #154 A): the
 * local ref before them may hold any character and is not used. A non-empty
 * line whose last three fields are not a sha, a non-empty remote ref and a sha
 * is an error (exit 1). With no non-empty line it prints that nothing was
 * checked and exits 0.
 *
 * `git log -z --format=%H` lists the outgoing commits, NUL-framed and in UTF-8
 * whatever `i18n.logOutputEncoding` says; each name must be a full sha. One
 * `git cat-file --batch` then reads their raw objects (decision #155 A), each
 * checked against its name and size, and every identity line of each header
 * is checked: `author`, `committer`, and each `tagger` line of a tag embedded
 * in a `mergetag` field (`git merge` of a signed tag). Pushed tag objects are
 * read the same way, and every `tagger` line counts, the first one (which git
 * shows) included. The bytes checked are the bytes pushed: a header is decoded
 * as strict UTF-8, not re-encoded by its `encoding` field, and a header that
 * is not valid UTF-8 is refused (fails closed) without its bytes being shown.
 * Output of the wrong shape is an error (exit 1).
 *
 * The refusal lists each offence (sha, field, address, with control
 * characters written as `\u{..}`) and then fixed advice that names no ref; the
 * common branch case is in docs/workflow.md.
 *
 * Only these identity fields count; `Co-Authored-By:` trailers are
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

/**
 * A control character, C0, DEL or C1 (U+0000–U+001F, U+007F–U+009F). No `i`
 * flag: with `u` it would turn on Unicode case folding.
 */
const CONTROL = /\p{Cc}/u;
/** Every control character, for {@link printable}. */
const CONTROLS = /\p{Cc}/gu;

/** Whether `text` holds a control character (decision #154 A, security lane S3.5). */
const hasControl = (text: string) => CONTROL.test(text);

/**
 * `text` with each control character written as `\u{..}`, so a refusal
 * cannot move the cursor or set a terminal's title (security lane S3.4).
 */
const printable = (text: string) =>
  text.replace(CONTROLS, (c) => `\\u{${c.codePointAt(0)?.toString(16)}}`);

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
  /**
   * `merged tagger` is the tagger of a signed tag a merge commit embeds in
   * its `mergetag` header; `header` is a commit or tag header that is not
   * valid UTF-8 (its email is empty).
   */
  field: "author" | "committer" | "tagger" | "merged tagger" | "header";
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

/** One object as `git cat-file --batch` prints it. */
interface GitObject {
  type: string;
  body: Buffer;
}

/** The ASCII header line `git cat-file --batch` prints before each object. */
const BATCH_INFO = /^([0-9a-f]{40,64}) ([a-z]+) ([0-9]+)$/;

/**
 * The raw objects `shas` name, in order, read by one `git cat-file --batch`
 * (undefined for an object this clone does not have). Each object is checked
 * against its name and size; output of any other shape is an error.
 */
function readObjects(
  shas: string[],
  options: GitOptions,
): (GitObject | undefined)[] {
  if (shas.length === 0) return [];
  const batch = spawnSync(
    "git",
    ["--no-replace-objects", "cat-file", "--batch"],
    {
      ...options,
      input: shas.map((sha) => `${sha}\n`).join(""),
      maxBuffer: Number.POSITIVE_INFINITY,
    },
  );
  if (batch.status !== 0) {
    const cause = batch.error?.message ?? batch.stderr.toString();
    throw new Error(`git cat-file --batch failed: ${cause}`);
  }
  const out = batch.stdout;
  let at = 0;
  const objects = shas.map((sha) => {
    const end = out.indexOf(0x0a, at);
    const info = end < 0 ? "" : out.toString("latin1", at, end);
    at = end + 1;
    if (info === `${sha} missing`) return undefined;
    const match = BATCH_INFO.exec(info);
    const size = Number(match?.[3]);
    if (match?.[1] !== sha || out[at + size] !== 0x0a) {
      throw new Error(
        `git cat-file printed output of an unexpected shape for ${sha}`,
      );
    }
    const body = out.subarray(at, at + size);
    at += size + 1;
    return { type: match[2] ?? "", body };
  });
  if (at !== out.length) {
    throw new Error("git cat-file printed output of an unexpected shape");
  }
  return objects;
}

/** A header field: its key and its value, continuation lines joined by `\n`. */
interface Field {
  key: string;
  value: string;
}

/** Decodes strictly: a byte sequence that is not UTF-8 throws. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * The header fields of an object's text, up to its first empty line. A line
 * that starts with a space continues the field before it (as in `gpgsig` and
 * `mergetag`), without that space.
 */
function fieldsOf(lines: string[]): Field[] {
  const fields: Field[] = [];
  for (const row of lines) {
    if (row === "") break;
    const last = fields.at(-1);
    if (row.startsWith(" ") && last !== undefined) {
      last.value += `\n${row.slice(1)}`;
      continue;
    }
    const space = row.indexOf(" ");
    fields.push(
      space < 0
        ? { key: row, value: "" }
        : { key: row.slice(0, space), value: row.slice(space + 1) },
    );
  }
  return fields;
}

/**
 * The header fields of a raw commit or tag object, decoded as strict UTF-8,
 * or undefined when the header (everything before the first empty line) is
 * not valid UTF-8.
 */
function headerOf(body: Buffer): Field[] | undefined {
  const end = body[0] === 0x0a ? 0 : body.indexOf("\n\n");
  try {
    const text = UTF8.decode(body.subarray(0, end < 0 ? body.length : end));
    return fieldsOf(text.split("\n"));
  } catch {
    return undefined;
  }
}

/** The value of the first field named `key`, as git reads it, if any. */
const first = (fields: Field[], key: string) =>
  fields.find((field) => field.key === key)?.value;

/** The address in an identity, `Name <address> <time> <zone>`, or "" without one. */
const addressOf = (identity: string) => /<([^>]*)>/.exec(identity)?.[1] ?? "";

/**
 * The offences of every `tagger` line in a tag's header fields, each named
 * by the tag's first `tag` line; a tag with no tagger line is refused (an
 * empty address).
 */
function taggerOffences(
  sha: string,
  fields: Field[],
  field: "tagger" | "merged tagger",
): Offence[] {
  const tag = first(fields, "tag") ?? "";
  const taggers = fields.filter((f) => f.key === "tagger");
  const emails =
    taggers.length === 0 ? [""] : taggers.map((f) => addressOf(f.value));
  return emails
    .filter((email) => !isAllowed(email))
    .map((email) => ({ sha, field, email, tag }));
}

/** The refusal of an object whose header is not UTF-8; its bytes are not shown. */
const undecodable = (sha: string): Offence => ({
  sha,
  field: "header",
  email: "",
});

/**
 * The tagger offences of `sha` when it is an annotated tag: its own, then
 * those of each tag it names in turn, down to the first object that is not a
 * tag. Anything else, or an object git cannot read, has none here; the
 * commits are then read through `git log`, which fails for an unknown sha.
 */
function tagOffences(sha: string, options: GitOptions): Offence[] {
  const offences: Offence[] = [];
  let current: string | undefined = sha;
  while (current !== undefined) {
    const [object] = readObjects([current], options);
    if (object?.type !== "tag") break;
    const fields = headerOf(object.body);
    if (fields === undefined) {
      offences.push(undecodable(current));
      break;
    }
    offences.push(...taggerOffences(current, fields, "tagger"));
    const next = first(fields, "object") ?? "";
    current = SHA.test(next) ? next : undefined;
  }
  return offences;
}

/**
 * One commit's offences, from its raw header: every `author` and `committer`
 * line, and every `tagger` line of each tag a `mergetag` field embeds (a
 * merge of a signed tag, decision #155 A).
 */
function commitOffences(sha: string, body: Buffer): Offence[] {
  const fields = headerOf(body);
  if (fields === undefined) return [undecodable(sha)];
  return fields.flatMap((field): Offence[] => {
    if (field.key === "author" || field.key === "committer") {
      const email = addressOf(field.value);
      return isAllowed(email) ? [] : [{ sha, field: field.key, email }];
    }
    if (field.key === "mergetag") {
      const tag = fieldsOf(field.value.split("\n"));
      return taggerOffences(sha, tag, "merged tagger");
    }
    return [];
  });
}

/**
 * The commit names in NUL-framed `git log --format=%H` output, `<sha> NUL`
 * per commit; any other shape is an error.
 */
function shasInLog(stdout: string): string[] {
  const shas = stdout.split("\0");
  if (shas.pop() !== "") {
    throw new Error("git log printed output of an unexpected shape");
  }
  for (const sha of shas) {
    if (!SHA.test(sha)) {
      throw new Error(
        `git log printed an unexpected commit name: ${printable(sha)}`,
      );
    }
  }
  return shas;
}

/** The offences among the commits `revisions` selects, read from their raw objects. */
function offencesIn(revisions: string[], options: GitOptions): Offence[] {
  const log = git(
    [
      "log",
      "-z",
      "--encoding=UTF-8",
      "--no-show-signature",
      "--format=%H",
      ...revisions,
      "--",
    ],
    options,
  );
  if (log.status !== 0) {
    const cause = log.error?.message ?? log.stderr;
    throw new Error(`git log ${revisions.join(" ")} failed: ${cause}`);
  }
  const shas = shasInLog(log.stdout);
  const objects = readObjects(shas, options);
  return shas.flatMap((sha, i) => {
    const object = objects[i];
    if (object?.type !== "commit") {
      throw new Error(`git cat-file could not read commit ${sha}`);
    }
    return commitOffences(sha, object.body);
  });
}

/** The offences of one pushed ref. */
function rowOffences({ local, remote }: Row, options: GitOptions): Offence[] {
  const revisions = outgoing(local, remote, options);
  if (revisions === undefined) return [];
  return [...tagOffences(local, options), ...offencesIn(revisions, options)];
}

/**
 * Every address that is not allowed among outgoing commits' authors and
 * committers, pushed annotated tags' taggers and merged signed tags' taggers,
 * and every such commit or tag header that is not valid UTF-8.
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
      `  ${o.sha.slice(0, 12)} ${o.field} ` +
      (o.field === "header" ? "(not valid UTF-8)" : printable(o.email)) +
      (o.tag === undefined ? "" : ` (tag ${printable(o.tag)})`),
  );
  return [
    "push refused: each outgoing commit's author and committer, each pushed tag's tagger",
    "and each merged signed tag's tagger must be a GitHub noreply address,",
    `an address ending in ${NOREPLY_SUFFIX} or exactly ${GITHUB_EMAIL}`,
    "(one @, no whitespace, control character, < or >; a header that is not UTF-8 is refused;",
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
