import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_EMAIL, check, format } from "./check-push-email";

// Each test builds a throwaway repository and feeds the check the lines git
// gives a pre-push hook on stdin. No network: "remote" refs are written
// straight into refs/remotes/.

const SCRIPT = fileURLToPath(new URL("check-push-email.ts", import.meta.url));
const ZERO = "0".repeat(40);
const OTHER = "someone@example.com";

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

  it("formats each offence with the short hash, field, address and a fix", () => {
    const text = format([
      { sha: "a".repeat(40), field: "author", email: OTHER },
    ]);
    expect(text).toContain(`aaaaaaaaaaaa author ${OTHER}`);
    expect(text).toContain(ALLOWED_EMAIL);
    expect(text).toContain("--reset-author");
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
});
