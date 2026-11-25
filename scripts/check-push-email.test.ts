import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * The environment for the throwaway repository: none of the GIT_* variables
 * a surrounding hook sets (GIT_DIR would point every command at this
 * repository), no global or system config (signing, hooks), fixed dates.
 */
function repoEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
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
    expect(text).toContain("--reset-author");
  });

  it("advises a rebase of the offending branch that keeps authors by default", () => {
    const text = format(
      [{ sha: "a".repeat(40), field: "committer", email: OTHER }],
      ["refs/heads/topic"],
    );
    const command = text.split("\n").find((row) => row.includes("git rebase"));
    expect(command).toBe(
      "  git rebase -r --exec 'git commit --amend --no-edit' <base> <branch>",
    );
    expect(command).not.toContain("--reset-author");
    expect(text).toMatch(/<branch> the local branch that holds them: topic\b/);
    expect(text).toContain(
      "Use --reset-author only for author rows that are your own commits",
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

  it("passes a large clean history, beyond the default output buffer", () => {
    // About 10,000 commits print roughly 1.1 MB through the check's git log,
    // above spawnSync's 1 MiB default. fast-import writes them in one process.
    const count = 10_000;
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
    expect(refused.stderr).toContain("the local branch that holds them: main.");

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
  ])("refuses %j", (email) => {
    expect(isAllowed(email)).toBe(false);
  });
});

describe("lefthook.yml pre-push", () => {
  it("runs the check first, as a script job with stdin, under a piped hook", () => {
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!key.startsWith("GIT_")) env[key] = value;
    }
    const dump = JSON.parse(
      execFileSync("bunx", ["lefthook", "dump", "--format", "json"], {
        cwd: ROOT,
        env,
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
