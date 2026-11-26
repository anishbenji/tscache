import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { check, format, isAllowed } from "./check-push-email";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Each test builds a throwaway repository and feeds the check the lines git
// gives a pre-push hook on stdin. No network: "remote" refs are written
// straight into refs/remotes/.

const SCRIPT = fileURLToPath(new URL("check-push-email.ts", import.meta.url));
const ZERO = "0".repeat(40);
const OTHER = "someone@example.com";
/** The repository's own address (user decision #141 A); any noreply address passes. */
const ALLOWED_EMAIL = "anishbenji@users.noreply.github.com";
const DEPENDABOT = "49699333+dependabot[bot]@users.noreply.github.com";
const GITHUB = "noreply@github.com";

/**
 * The fixed advice after the offence rows (decision #154 A): the same for
 * every offence, with no ref name and no per-ref command.
 */
const ADVICE = [
  "",
  "To fix, set your GitHub noreply address (github.com/settings/emails):",
  "  git config user.email <you>@users.noreply.github.com",
  "Rewrite the listed commits, or re-create the listed tags, with that address, then push again.",
  "Never rewrite a commit or tag that is already pushed: others may have fetched it.",
  'For the common case, a branch: docs/workflow.md, "One-time setup", item 4 (Git hooks).',
].join("\n");

/** Asserts that `text` ends in the fixed advice and names no ref or peel. */
function expectFixedAdvice(text: string): void {
  expect(text.endsWith(ADVICE)).toBe(true);
  expect(text).not.toContain("^{}");
  expect(text).not.toContain("refs/");
  expect(text).not.toContain("git rebase");
  expect(text).not.toContain("git tag");
}

/**
 * The environment for the throwaway repository: none of the GIT_* variables
 * a surrounding hook sets (GIT_DIR would point every command at this
 * repository), none of the LEFTHOOK* variables a developer may export for
 * another checkout (LEFTHOOK_CONFIG would replace the config under test), no
 * global or system config (signing, hooks), fixed dates.
 */
function repoEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && !key.startsWith("LEFTHOOK")) {
      env[key] = value;
    }
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  };
}

let dir: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], extra: NodeJS.ProcessEnv = {}): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: { ...env, ...extra },
    encoding: "utf8",
  }).trim();
}

/** Commits a new file as `author`, committed by `committer`; returns the SHA. */
function commit(
  name: string,
  author = ALLOWED_EMAIL,
  committer = ALLOWED_EMAIL,
  message = name,
): string {
  writeFileSync(join(dir, name), name);
  git(["add", name]);
  git(["commit", "-q", "-m", message], {
    GIT_AUTHOR_NAME: "A",
    GIT_AUTHOR_EMAIL: author,
    GIT_COMMITTER_NAME: "C",
    GIT_COMMITTER_EMAIL: committer,
  });
  return git(["rev-parse", "HEAD"]);
}

/** Creates the annotated tag `name` on `target`, tagged by `tagger`; returns the tag object's SHA. */
function tag(name: string, target: string, tagger = ALLOWED_EMAIL): string {
  // A tag of a tag is meant here; the hint git prints for one is noise.
  git(["-c", "advice.nestedTag=false", "tag", "-a", name, "-m", name, target], {
    GIT_COMMITTER_NAME: "T",
    GIT_COMMITTER_EMAIL: tagger,
  });
  return git(["rev-parse", `refs/tags/${name}`]);
}

/** Marks `sha` as already on the remote, as `git fetch` would. */
function onRemote(branch: string, sha: string): void {
  git(["update-ref", `refs/remotes/origin/${branch}`, sha]);
}

const line = (local: string, remote: string, ref = "refs/heads/main") =>
  `${ref} ${local} ${ref} ${remote}\n`;

const run = (stdin: string) => check(stdin, { cwd: dir, env });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tscache-push-email-"));
  env = repoEnv();
  git(["init", "-q", "-b", "main"]);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Each test spawns about ten git processes, a few hundred milliseconds in
// all on an idle machine but several seconds under a parallel Vitest run on
// a loaded one; the limit only ends a hung test, no assertion reads time.
describe("check-push-email", { timeout: 30_000 }, () => {
  it("passes an existing branch whose outgoing commits use the allowed address", () => {
    const base = commit("a");
    onRemote("main", base);
    const head = commit("b");
    expect(run(line(head, base))).toEqual([]);
  });

  it("refuses an outgoing commit with another author address", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER, ALLOWED_EMAIL);
    const head = commit("c");
    expect(run(line(head, base))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("refuses an outgoing commit with another committer address", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", ALLOWED_EMAIL, OTHER);
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "committer", email: OTHER },
    ]);
  });

  it("reports both fields when both are wrong", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER, "third@example.com");
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "author", email: OTHER },
      { sha: bad, field: "committer", email: "third@example.com" },
    ]);
  });

  it("does not check commits already pushed, before the remote SHA", () => {
    const old = commit("a", OTHER, OTHER);
    onRemote("main", old);
    const head = commit("b");
    expect(run(line(head, old))).toEqual([]);
  });

  it("checks a new branch's commits that no remote-tracking ref holds", () => {
    const old = commit("a", OTHER, OTHER);
    onRemote("main", old);
    git(["checkout", "-q", "-b", "feat"]);
    const good = commit("b");
    expect(run(line(good, ZERO, "refs/heads/feat"))).toEqual([]);
    const bad = commit("c", OTHER);
    expect(run(line(bad, ZERO, "refs/heads/feat"))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("checks every commit of a new branch when nothing is on a remote", () => {
    const bad = commit("a", OTHER);
    const head = commit("b");
    expect(run(line(head, ZERO))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("falls back to the new-branch range when the remote SHA is unknown here", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER);
    const unknown = "1".repeat(40);
    expect(run(line(bad, unknown))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("checks nothing for a deleted ref", () => {
    commit("a", OTHER, OTHER);
    const remote = git(["rev-parse", "HEAD"]);
    expect(run(line(ZERO, remote))).toEqual([]);
  });

  it("ignores Co-Authored-By trailers, which are message text", () => {
    const base = commit("a");
    onRemote("main", base);
    const head = commit(
      "b",
      ALLOWED_EMAIL,
      ALLOWED_EMAIL,
      `b\n\nCo-Authored-By: Someone <${OTHER}>`,
    );
    expect(run(line(head, base))).toEqual([]);
  });

  it("checks every ref pushed at once, and nothing for empty stdin", () => {
    const base = commit("a");
    onRemote("main", base);
    const good = commit("b");
    git(["checkout", "-q", "-b", "feat"]);
    const bad = commit("c", OTHER);
    const stdin = line(good, base) + line(bad, ZERO, "refs/heads/feat");
    expect(run(stdin)).toEqual([{ sha: bad, field: "author", email: OTHER }]);
    expect(run("")).toEqual([]);
  });

  it("does not check commits merged in from another remote-tracking ref", () => {
    const base = commit("a");
    onRemote("feat", base);
    git(["checkout", "-q", "-b", "other"]);
    const merged = commit("b", OTHER, OTHER);
    onRemote("main", merged);
    git(["checkout", "-q", "main"]);
    git(["merge", "-q", "--no-ff", "-m", "merge", "other"], {
      GIT_AUTHOR_NAME: "A",
      GIT_AUTHOR_EMAIL: ALLOWED_EMAIL,
      GIT_COMMITTER_NAME: "C",
      GIT_COMMITTER_EMAIL: ALLOWED_EMAIL,
    });
    const head = git(["rev-parse", "HEAD"]);
    const feat = "refs/heads/feat";
    expect(run(line(head, base, feat))).toEqual([]);
    const bad = commit("c", OTHER);
    expect(run(line(bad, base, feat))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("refuses a non-empty row that is not four fields", () => {
    const base = commit("a");
    expect(() => run(`refs/heads/main ${base} refs/heads/main\n`)).toThrow(
      /malformed pre-push line/,
    );
  });

  it("throws when git log fails, for a local SHA this clone does not have", () => {
    const base = commit("a");
    onRemote("main", base);
    expect(() => run(line("2".repeat(40), base))).toThrow(/git log/);
  });

  it("passes commits by a bot's and GitHub's noreply addresses (#147 A)", () => {
    const base = commit("a");
    onRemote("main", base);
    commit("b", DEPENDABOT, GITHUB);
    const head = commit("c", ALLOWED_EMAIL.toUpperCase(), GITHUB.toUpperCase());
    expect(run(line(head, base))).toEqual([]);
  });

  it("formats each offence with the short hash, field, address, the rule and a fix", () => {
    const text = format([
      { sha: "a".repeat(40), field: "author", email: OTHER },
    ]);
    expect(text).toContain(`aaaaaaaaaaaa author ${OTHER}`);
    expect(text).toContain("an address ending in @users.noreply.github.com");
    expect(text).toContain(`or exactly ${GITHUB}`);
    expect(text).toContain("<you>@users.noreply.github.com");
    expectFixedAdvice(text);
  });

  it("names every offending sha and field, then the same fixed advice", () => {
    const text = format([
      { sha: "a".repeat(40), field: "author", email: OTHER },
      { sha: "a".repeat(40), field: "committer", email: GITHUB.slice(1) },
      { sha: "c".repeat(40), field: "tagger", email: "", tag: "v1" },
    ]);
    const rows = text
      .split("\n")
      .filter((row) => row.startsWith("  ") && !row.includes("git config"));
    expect(rows).toEqual([
      `  aaaaaaaaaaaa author ${OTHER}`,
      `  aaaaaaaaaaaa committer ${GITHUB.slice(1)}`,
      "  cccccccccccc tagger  (tag v1)",
    ]);
    expectFixedAdvice(text);
    const commitsOnly = format([
      { sha: "a".repeat(40), field: "committer", email: OTHER },
    ]);
    expect(commitsOnly.slice(commitsOnly.indexOf("\n\n"))).toBe(
      text.slice(text.indexOf("\n\n")),
    );
  });

  it("passes a clean SSH-signed commit when log.showSignature is set", () => {
    const base = commit("a");
    onRemote("main", base);
    const key = join(dir, ".git", "signing-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    const pub = readFileSync(`${key}.pub`, "utf8").trim();
    const signers = join(dir, ".git", "allowed-signers");
    writeFileSync(signers, `${ALLOWED_EMAIL} namespaces="git" ${pub}\n`);
    git(["config", "gpg.format", "ssh"]);
    git(["config", "user.signingkey", key]);
    git(["config", "gpg.ssh.allowedSignersFile", signers]);
    git(["config", "log.showSignature", "true"]);
    git(["config", "commit.gpgSign", "true"]);
    const head = commit("b");
    // The commit is signed and verifies; the config makes plain git log print
    // the signature next to every formatted record.
    expect(
      git(["log", "-1", "--no-show-signature", "--format=%G?", head]),
    ).toBe("G");
    expect(git(["log", "-1", "--format=%H", head])).not.toBe(head);
    expect(run(line(head, base))).toEqual([]);
  });

  it("parses ref names with a no-break space or a reflog expression", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER);
    const nbsp = "refs/heads/fix email";
    expect(run(line(bad, ZERO, nbsp))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
    const reflog = `HEAD@{1 day ago} ${bad} refs/heads/main ${base}\n`;
    expect(run(reflog)).toEqual([{ sha: bad, field: "author", email: OTHER }]);
    expect(() => run(`HEAD@{1 day ago} ${bad} refs/heads/main\n`)).toThrow(
      /malformed pre-push line/,
    );
  });

  it("parses a local ref holding U+2028, U+2029, U+00A0 and spaces", () => {
    const base = commit("a");
    onRemote("main", base);
    const head = commit("b");
    const ref = "refs/heads/a b c d e f";
    expect(run(`${ref} ${head} refs/heads/main ${base}\n`)).toEqual([]);
    const bad = commit("c", OTHER);
    expect(run(`${ref} ${bad} refs/heads/main ${base}\n`)).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
    expect(() => run(`${ref} ${head}\n`)).toThrow(/malformed pre-push line/);
    expect(() => run(`${head} ${base}\n`)).toThrow(/malformed pre-push line/);
  });

  // Decision #154 A: NUL-framed git log, so no byte inside an address can
  // shift the fields; Git cannot store a NUL in an address.
  it("reads the committer even when the author address holds U+001F", () => {
    const base = commit("a");
    onRemote("main", base);
    const author = "a@users.noreply.github.com\x1fb@users.noreply.github.com";
    const bad = commit("b", author, OTHER);
    expect(git(["log", "-1", "--format=%ae", bad])).toBe(author);
    // The author address is not well formed, so it is refused too.
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "author", email: author },
      { sha: bad, field: "committer", email: OTHER },
    ]);
  });

  it("refuses an author address with an interior space", () => {
    const base = commit("a");
    onRemote("main", base);
    const author = "me@gmail.com x@users.noreply.github.com";
    const bad = commit("b", author);
    expect(git(["log", "-1", "--format=%ae", bad])).toBe(author);
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "author", email: author },
    ]);
  });

  it("refuses a tagger address with an interior space", () => {
    const base = commit("a");
    onRemote("main", base);
    const tagger = "me@gmail.com x@users.noreply.github.com";
    const v1 = tag("v1", base, tagger);
    expect(run(line(v1, ZERO, "refs/tags/v1"))).toEqual([
      { sha: v1, field: "tagger", email: tagger, tag: "v1" },
    ]);
  });

  it("reads UTF-8 whatever i18n.logOutputEncoding says", () => {
    const base = commit("a");
    onRemote("main", base);
    git(["config", "i18n.logOutputEncoding", "UTF-16"]);
    const head = commit("b");
    expect(run(line(head, base))).toEqual([]);
    const bad = commit("c", OTHER);
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("passes a large clean history, beyond the default output buffer", () => {
    // Both of the check's git reads must pass spawnSync's 1 MiB (1,048,576
    // bytes) default buffer. `git log -z --format=%H` prints 41 bytes per
    // SHA-1 commit (the sha and a NUL), so it needs more than 25,575 commits:
    // 26,000 print 1,066,000 bytes. `git cat-file --batch` prints each raw
    // commit with its header line, about 280 bytes each, so it passes the
    // default far sooner. fast-import writes them in one process.
    const count = 26_000;
    const ident = `A <${ALLOWED_EMAIL}> 1767225600 +0000`;
    const stream = Array.from({ length: count }, (_, i) =>
      [
        "commit refs/heads/main",
        `committer ${ident}`,
        "data 1",
        `${i % 10}`,
        "",
      ].join("\n"),
    ).join("");
    execFileSync("git", ["fast-import", "--quiet"], {
      cwd: dir,
      env,
      input: stream,
    });
    const head = git(["rev-parse", "refs/heads/main"]);
    expect(run(line(head, ZERO))).toEqual([]);
    const result = script(line(head, ZERO));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("exits 1 naming the commit as a Bun script, and 0 when clean", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER);
    const refused = spawnSync("bun", [SCRIPT], {
      cwd: dir,
      env,
      input: line(bad, base),
      encoding: "utf8",
      // Only ends a hung child; no assertion depends on it.
      timeout: 60_000,
    });
    expect(refused.error).toBeUndefined();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain(`${bad.slice(0, 12)} author ${OTHER}`);
    expectFixedAdvice(refused.stderr.trimEnd());

    const passed = spawnSync("bun", [SCRIPT], {
      cwd: dir,
      env,
      input: line(base, base),
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(passed.error).toBeUndefined();
    expect(passed.status).toBe(0);
  });

  // Decision #153 A: an annotated tag's tagger is checked with the same rule.
  it("refuses a new annotated tag by another tagger on a pushed commit (#153 A)", () => {
    const base = commit("a");
    onRemote("main", base);
    const v1 = tag("v1", base, OTHER);
    expect(run(line(v1, ZERO, "refs/tags/v1"))).toEqual([
      { sha: v1, field: "tagger", email: OTHER, tag: "v1" },
    ]);
  });

  it("passes the same annotated tag by an allowed tagger", () => {
    const base = commit("a");
    onRemote("main", base);
    const v1 = tag("v1", base, ALLOWED_EMAIL.toUpperCase());
    expect(run(line(v1, ZERO, "refs/tags/v1"))).toEqual([]);
  });

  it("checks a lightweight tag as the commits it names, as before", () => {
    const base = commit("a");
    onRemote("main", base);
    git(["tag", "light", base]);
    expect(run(line(base, ZERO, "refs/tags/light"))).toEqual([]);
    const bad = commit("b", OTHER);
    git(["tag", "light2", bad]);
    expect(run(line(bad, ZERO, "refs/tags/light2"))).toEqual([
      { sha: bad, field: "author", email: OTHER },
    ]);
  });

  it("checks each level of a nested tag, and the commits under it", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER);
    const inner = tag("inner", bad, "third@example.com");
    const outer = tag("outer", inner, OTHER);
    expect(run(line(outer, ZERO, "refs/tags/outer"))).toEqual([
      { sha: outer, field: "tagger", email: OTHER, tag: "outer" },
      { sha: inner, field: "tagger", email: "third@example.com", tag: "inner" },
      { sha: bad, field: "author", email: OTHER },
    ]);
    const clean = tag("clean", tag("cleaninner", base));
    expect(run(line(clean, ZERO, "refs/tags/clean"))).toEqual([]);
  });

  it("ignores replace refs: a refused commit stays refused after git replace", () => {
    const base = commit("a");
    onRemote("main", base);
    const bad = commit("b", OTHER, OTHER);
    const v1 = tag("v1", base, OTHER);
    const before = run(line(bad, base));
    expect(before).toEqual([
      { sha: bad, field: "author", email: OTHER },
      { sha: bad, field: "committer", email: OTHER },
    ]);
    // What `git replace --edit` does, without an editor: a copy of each object
    // with the allowed address, recorded as its replacement.
    for (const [sha, type] of [
      [bad, "commit"],
      [v1, "tag"],
    ] as const) {
      const raw = git(["cat-file", type, sha]).replaceAll(OTHER, ALLOWED_EMAIL);
      const copy = execFileSync(
        "git",
        ["hash-object", "-t", type, "-w", "--stdin"],
        { cwd: dir, env, input: `${raw}\n`, encoding: "utf8" },
      ).trim();
      git(["replace", sha, copy]);
    }
    expect(git(["log", "-1", "--format=%ae %ce", bad])).toBe(
      `${ALLOWED_EMAIL} ${ALLOWED_EMAIL}`,
    );
    expect(run(line(bad, base))).toEqual(before);
    expect(run(line(v1, ZERO, "refs/tags/v1"))).toEqual([
      { sha: v1, field: "tagger", email: OTHER, tag: "v1" },
    ]);
  });

  it("gives a refused tag the fixed advice, and no rebase or tag command", () => {
    const text = format([
      { sha: "b".repeat(40), field: "tagger", email: OTHER, tag: "v1" },
    ]);
    expect(text).toContain(`bbbbbbbbbbbb tagger ${OTHER} (tag v1)`);
    expect(text).toContain("tagger");
    expectFixedAdvice(text);
    expect(text).toContain(
      "Never rewrite a commit or tag that is already pushed",
    );
    expect(text).not.toContain("git rebase");
  });

  /** Writes `raw` as a loose object of `type` without git's checks; returns its SHA. */
  function literally(type: "commit" | "tag", raw: string | Buffer): string {
    return execFileSync(
      "git",
      ["hash-object", "-t", type, "-w", "--literally", "--stdin"],
      { cwd: dir, env, input: raw, encoding: "utf8" },
    ).trim();
  }

  /** Makes a throwaway SSH key in the test's repository and signs with it. */
  function sshSigning(): void {
    const key = join(dir, ".git", "signing-key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    git(["config", "gpg.format", "ssh"]);
    git(["config", "user.signingkey", key]);
  }

  // Security lane run 3 and decision #155 A: the identities are read from each
  // outgoing commit's raw header, so the bytes checked are the bytes pushed.
  it("reads the stored address of an ISO-2022-JP commit, not a re-encoded one (S3.1)", () => {
    const base = commit("a");
    onRemote("main", base);
    const email = "a\x1b$Bme@gmail.com\x1b(Bx@users.noreply.github.com";
    git(
      [
        "-c",
        "i18n.commitEncoding=ISO-2022-JP",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "bad",
      ],
      {
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: email,
        GIT_COMMITTER_NAME: "C",
        GIT_COMMITTER_EMAIL: email,
      },
    );
    const bad = git(["rev-parse", "HEAD"]);
    expect(git(["cat-file", "commit", bad])).toContain("encoding ISO-2022-JP");
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "author", email },
      { sha: bad, field: "committer", email },
    ]);
  });

  it("refuses a commit whose header is not UTF-8, without printing its bytes", () => {
    const base = commit("a");
    onRemote("main", base);
    const tree = git(["rev-parse", `${base}^{tree}`]);
    const ident = `<${ALLOWED_EMAIL}> 1767225600 +0000`;
    const raw = Buffer.concat([
      Buffer.from(`tree ${tree}\nparent ${base}\nauthor Ren`),
      Buffer.from([0xe9]),
      Buffer.from(` ${ident}\ncommitter C ${ident}\n\nlatin-1\n`),
    ]);
    const bad = literally("commit", raw);
    const offences = run(line(bad, base));
    expect(offences).toEqual([{ sha: bad, field: "header", email: "" }]);
    const text = format(offences);
    expect(text).toContain(`${bad.slice(0, 12)} header (not valid UTF-8)`);
    expect(text).not.toContain("�");
  });

  it("refuses a merged signed tag's tagger in the mergetag header (S3.2, #155 A)", () => {
    const base = commit("a");
    onRemote("main", base);
    sshSigning();
    git(["checkout", "-q", "-b", "side"]);
    const side = commit("b");
    const signed = (name: string, tagger: string) =>
      git(["tag", "-s", "-m", name, name, side], {
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: tagger,
      });
    signed("st", OTHER);
    signed("clean", ALLOWED_EMAIL);
    git(["checkout", "-q", "main"]);
    const merge = (name: string) => {
      git(["merge", "-q", "--no-ff", "-m", `merge ${name}`, name], {
        GIT_AUTHOR_NAME: "A",
        GIT_AUTHOR_EMAIL: ALLOWED_EMAIL,
        GIT_COMMITTER_NAME: "C",
        GIT_COMMITTER_EMAIL: ALLOWED_EMAIL,
      });
      return git(["rev-parse", "HEAD"]);
    };
    const bad = merge("st");
    expect(git(["cat-file", "commit", bad])).toContain(
      `\n tagger T <${OTHER}>`,
    );
    expect(run(line(bad, base))).toEqual([
      { sha: bad, field: "merged tagger", email: OTHER, tag: "st" },
    ]);
    git(["reset", "-q", "--hard", base]);
    const good = merge("clean");
    expect(git(["cat-file", "commit", good])).toContain("\nmergetag object ");
    expect(run(line(good, base))).toEqual([]);
  });

  it("checks every tagger line of a tag object, the first one included (S3.3)", () => {
    const base = commit("a");
    onRemote("main", base);
    const tagObject = (first: string, second: string) =>
      literally(
        "tag",
        [
          `object ${base}`,
          "type commit",
          "tag v1",
          `tagger n <${first}> 1 +0000`,
          `tagger n <${second}> 1 +0000`,
          "",
          "msg",
          "",
        ].join("\n"),
      );
    const firstBad = tagObject(OTHER, ALLOWED_EMAIL);
    expect(run(line(firstBad, ZERO, "refs/tags/v1"))).toEqual([
      { sha: firstBad, field: "tagger", email: OTHER, tag: "v1" },
    ]);
    const secondBad = tagObject(ALLOWED_EMAIL, OTHER);
    expect(run(line(secondBad, ZERO, "refs/tags/v1"))).toEqual([
      { sha: secondBad, field: "tagger", email: OTHER, tag: "v1" },
    ]);
  });

  it("names a tag object's first tag line, as git does (S3.3)", () => {
    const base = commit("a");
    onRemote("main", base);
    const v1 = literally(
      "tag",
      `object ${base}\ntype commit\ntag v1\ntag v2\ntagger n <${OTHER}> 1 +0000\n\nmsg\n`,
    );
    expect(run(line(v1, ZERO, "refs/tags/v1"))).toEqual([
      { sha: v1, field: "tagger", email: OTHER, tag: "v1" },
    ]);
  });

  it("prints addresses and tag names with control characters escaped (S3.4)", () => {
    const base = commit("a");
    onRemote("main", base);
    const email = "me\x1b[2K\x1b[1A@gmail.com";
    const bad = commit("b", email);
    const result = script(line(bad, base));
    expect(result.status).toBe(1);
    expect(
      [...result.stderr].filter((c) => c !== "\n" && c.charCodeAt(0) < 0x20),
    ).toEqual([]);
    expect(result.stderr).toContain(
      `${bad.slice(0, 12)} author me\\u{1b}[2K\\u{1b}[1A@gmail.com`,
    );
    const text = format([
      {
        sha: "d".repeat(40),
        field: "tagger",
        email: "x\u009b\x7f@gmail.com",
        tag: "a\x1b]0;TITLE\x07b",
      },
    ]);
    expect(text).toContain(
      "dddddddddddd tagger x\\u{9b}\\u{7f}@gmail.com (tag a\\u{1b}]0;TITLE\\u{7}b)",
    );
  });

  /** Runs the script as a Bun script with `stdin`. */
  function script(stdin: string) {
    const result = spawnSync("bun", [SCRIPT], {
      cwd: dir,
      env,
      input: stdin,
      encoding: "utf8",
      // Only ends a hung child; no assertion depends on it.
      timeout: 60_000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it("exits 0 and says nothing was checked for empty pre-push input", () => {
    const result = script("\n");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("no pre-push input; nothing checked");
  });

  it("exits 1 naming a refused tag's tagger as a Bun script", () => {
    const base = commit("a");
    onRemote("main", base);
    const v1 = tag("v1", base, OTHER);
    const result = script(line(v1, ZERO, "refs/tags/v1"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${v1.slice(0, 12)} tagger ${OTHER} (tag v1)`,
    );
    expectFixedAdvice(result.stderr.trimEnd());
  });

  it("exits 1 for a malformed row and for an unknown local SHA", () => {
    const base = commit("a");
    onRemote("main", base);
    const malformed = script(`refs/heads/main ${base}\n`);
    expect(malformed.status).toBe(1);
    expect(malformed.stderr).toContain("malformed pre-push line");
    const unknown = script(line("2".repeat(40), base));
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("git log");
  });
});

// User decision #147 A: any GitHub noreply address, or GitHub's own address,
// matched exactly and case-insensitively; every lookalike is refused.
describe("isAllowed", () => {
  it.each([
    ALLOWED_EMAIL,
    DEPENDABOT,
    GITHUB,
    ALLOWED_EMAIL.toUpperCase(),
    "Anishbenji@Users.NoReply.GitHub.com",
    DEPENDABOT.toUpperCase(),
    GITHUB.toUpperCase(),
    "NoReply@GitHub.com",
  ])("allows %j", (email) => {
    expect(isAllowed(email)).toBe(true);
  });

  it.each([
    "x@users.noreply.github.com.evil",
    "users.noreply.github.com",
    "x@xusers.noreply.github.com",
    "x@users-noreply.github.com",
    "noreply@github.com.evil",
    "x@noreply.github.com",
    "",
    "someone@gmail.com",
    OTHER,
    "me@gmail.com x@users.noreply.github.com",
    "a@users.noreply.github.com\x1fb@users.noreply.github.com",
    "me@gmail.com\tx@users.noreply.github.com",
    "<me@gmail.com>x@users.noreply.github.com",
    "a@b@users.noreply.github.com",
    "x@users.noreply.github.com\n",
    "x\x7f@users.noreply.github.com",
    "a\u009Bb@users.noreply.github.com",
  ])("refuses %j", (email) => {
    expect(isAllowed(email)).toBe(false);
  });
});

describe("lefthook.yml pre-push", () => {
  it("runs the check first, as a script job with stdin, under a piped hook", () => {
    // The tracked file alone, dumped in the throwaway repository: a developer's
    // lefthook-local.yml in the checkout would otherwise be merged in.
    copyFileSync(join(ROOT, "lefthook.yml"), join(dir, "lefthook.yml"));
    const lefthook = join(ROOT, "node_modules", ".bin", "lefthook");
    const dump = JSON.parse(
      execFileSync(lefthook, ["dump", "--format", "json"], {
        cwd: dir,
        env: { ...env, LEFTHOOK_CONFIG: join(dir, "lefthook.yml") },
        encoding: "utf8",
      }),
    );
    const hook = dump["pre-push"];
    expect(hook.piped).toBe(true);
    expect(hook.parallel).toBeUndefined();
    expect(hook.jobs[0]).toEqual({
      name: "push-email",
      script: "../check-push-email.ts",
      runner: "bun",
      use_stdin: true,
    });
    expect(dump.source_dir).toBe("scripts/");
  });
});
