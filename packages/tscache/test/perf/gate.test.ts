import { describe, expect, it } from "vitest";
import {
  acceptances,
  flagged,
  GATE,
  type Git,
  noisy,
  tallyCalibration,
  trailers,
  verdictOf,
} from "../../bench/gate";
import {
  medianRanks,
  type Sample,
  sample,
  sampleAsync,
  summarise,
} from "../../bench/sample";

// The timing gate's decisions (docs/benchmarking.md), which fail a pull
// request: tested here, apart from any timing.

function timed(ratio: number, low: number, high: number, baseMs = 0.1): Sample {
  return {
    ratios: [],
    ratio,
    low,
    high,
    baseMs,
    headMs: baseMs * ratio,
    batch: 1,
  };
}

describe("the gate", () => {
  it("flags a case only when ratio, interval and time all clear the gate", () => {
    expect(flagged(timed(1.12, 1.05, 1.2))).toBe(true);
    expect(flagged(timed(GATE.ratio, GATE.low, 1.2))).toBe(true);
    // The median alone is not enough: the interval must clear 1.03 too.
    expect(flagged(timed(1.12, 1.01, 1.2))).toBe(false);
    expect(flagged(timed(1.09, 1.05, 1.2))).toBe(false);
    // A 20 % regression of a 1 µs operation is 0.2 µs: under the floor;
    // of a 2 µs one, 0.4 µs: over it.
    expect(flagged(timed(1.2, 1.15, 1.25, 0.001))).toBe(false);
    expect(flagged(timed(1.2, 1.15, 1.25, 0.002))).toBe(true);
    expect(flagged(undefined)).toBe(false);
  });

  it("fails a case only when a fresh process confirms it, unless a trailer allows it", () => {
    const slow = timed(1.2, 1.12, 1.3);
    expect(verdictOf(slow, timed(1.2, 1.14, 1.25), undefined)).toBe(
      "regression",
    );
    expect(verdictOf(slow, timed(1.02, 0.98, 1.06), undefined)).toBe("flagged");
    expect(verdictOf(slow, undefined, undefined)).toBe("flagged");
    expect(verdictOf(slow, timed(1.2, 1.14, 1.25), 1.25)).toBe("accepted");
    // A trailer allows up to its ratio, not any slowdown.
    expect(verdictOf(slow, timed(1.3, 1.24, 1.35), 1.25)).toBe("regression");
    expect(verdictOf(timed(1.01, 0.98, 1.04), undefined, undefined)).toBe("ok");
    expect(verdictOf(timed(0.8, 0.78, 0.85), undefined, undefined)).toBe(
      "faster",
    );
  });

  it("calls a run noisy when its A/A control leaves [0.95, 1.05]", () => {
    expect(noisy(timed(1, 0.97, 1.03))).toBe(false);
    expect(noisy(timed(1, 0.94, 1.03))).toBe(true);
    expect(noisy(timed(1.02, 0.99, 1.06))).toBe(true);
    expect(noisy(undefined)).toBe(true);
  });

  it("reads Perf-Accepted trailers, with or without a runtime", () => {
    const message = [
      "perf(engine): trade read speed for memory",
      "",
      "Perf-Accepted: read-viewport 1.2 half the memory per bar",
      "Perf-Accepted: put-page@bun 1.15 JSC only",
      "Co-Authored-By: someone",
    ].join("\n");
    expect(trailers(message)).toEqual([
      ["read-viewport", 1.2],
      ["put-page@bun", 1.15],
    ]);
    expect(trailers("Perf-Accepted: no-ratio because")).toEqual([]);
  });
});

describe("the sampler", () => {
  it("bounds the median with the binomial order statistics", () => {
    expect(medianRanks(20)).toEqual([6, 15]);
    expect(medianRanks(30)).toEqual([10, 21]);
    expect(medianRanks(1000)).toEqual([469, 532]);
    // Fewer rounds give no interval; more underflow 0.5 ** n.
    expect(() => medianRanks(9)).toThrow(RangeError);
    expect(() => medianRanks(1001)).toThrow(RangeError);
  });

  /**
   * A clock the operations move, so the sampler's logic runs the same on
   * any machine at any load: each call of an operation takes exactly its
   * cost, and `stall` adds a pause to one call, as a busy machine does.
   */
  function virtualTime() {
    let now = 0;
    const calls: string[] = [];
    const op =
      (side: string, cost: number, stall?: { call: number; ms: number }) =>
      () => {
        calls.push(side);
        now += cost;
        if (stall?.call === calls.length) now += stall.ms;
        return 1;
      };
    return {
      clock: () => now,
      calls,
      op,
      advance: (ms: number) => (now += ms),
    };
  }

  it("finds no difference between an operation and itself, and the exact ratio of a slower one", () => {
    const options = { rounds: 10, batchMs: 5, warmupMs: 20 };
    const a = virtualTime();
    const same = sample(a.op("base", 0.25), a.op("head", 0.25), {
      ...options,
      clock: a.clock,
    });
    expect(same.ratios).toEqual(Array(10).fill(1));
    expect([same.ratio, same.low, same.high]).toEqual([1, 1, 1]);
    const b = virtualTime();
    const double = sample(b.op("base", 0.25), b.op("head", 0.5), {
      ...options,
      clock: b.clock,
    });
    expect(double.ratios).toEqual(Array(10).fill(2));
    expect([double.ratio, double.low, double.high]).toEqual([2, 2, 2]);
    expect([double.baseMs, double.headMs]).toEqual([0.25, 0.5]);
    // The slower side's batch reaches batchMs: 16 calls of 0.5 ms.
    expect(double.batch).toBe(16);
  });

  it("alternates which side runs first in each round", () => {
    const t = virtualTime();
    const s = sample(t.op("base", 0.25), t.op("head", 0.5), {
      rounds: 10,
      batchMs: 5,
      warmupMs: 20,
      clock: t.clock,
    });
    // The rounds are the last calls, one batch per side per round.
    const batches = t.calls
      .slice(-20 * s.batch)
      .filter((_, i) => i % s.batch === 0);
    expect(batches).toEqual(
      Array.from({ length: 10 }, (_, round) =>
        round % 2 === 0 ? ["base", "head"] : ["head", "base"],
      ).flat(),
    );
  });

  it("sizes batches from undisturbed timings, so a stall while calibrating does not shorten them", () => {
    // No warm-up, so the head's first call is calibration's: it stalls for
    // 100 ms, which alone would pass for a batch long enough.
    const t = virtualTime();
    const s = sample(
      t.op("base", 0.25),
      t.op("head", 0.5, { call: 2, ms: 100 }),
      { rounds: 10, batchMs: 5, warmupMs: 0, clock: t.clock },
    );
    expect(s.batch * 0.5).toBeGreaterThanOrEqual(5);
    expect(s.ratio).toBe(2);
  });

  it("keeps the median and its interval when one round stalls", () => {
    const t = virtualTime();
    const rounds = 10;
    // Calibration takes 3 timings per side at 1, 8 and 16 calls; the head's
    // calls in its fourth round batch come after those and three rounds.
    const calibration = 3 * (1 + 8 + 16) * 2;
    const stallAt = calibration + 3 * 2 * 16 + 1;
    const s = sample(
      t.op("base", 0.25),
      t.op("head", 0.5, { call: stallAt, ms: 50 }),
      { rounds, batchMs: 5, warmupMs: 0, clock: t.clock },
    );
    expect(Math.max(...s.ratios)).toBeGreaterThan(2);
    expect([s.ratio, s.low, s.high]).toEqual([2, 2, 2]);
  });

  it("summarises paired rounds into ratios, a median and its interval", () => {
    const base = Array.from({ length: 20 }, () => 10);
    const head = Array.from({ length: 20 }, (_, i) => 10 + i);
    const s = summarise(base, head, 5);
    expect(s.ratios).toEqual(head.map((h) => h / 10));
    expect(s.ratio).toBeCloseTo(1.95);
    // Ranks 6 and 15 of 20 (medianRanks).
    expect(s.low).toBeCloseTo(1.5);
    expect(s.high).toBeCloseTo(2.4);
    expect(s.baseMs).toBe(2);
    expect(s.headMs).toBeCloseTo(3.9);
    expect(s.batch).toBe(5);
  });

  it("times asynchronous operations the same way, resetting after each batch, outside the timer", async () => {
    const t = virtualTime();
    const asynchronous = (op: () => number) => async () => op();
    let resets = 0;
    const options = {
      rounds: 10,
      batchMs: 5,
      warmupMs: 20,
      clock: t.clock,
      // A reset that takes far longer than a batch moves no timing.
      between: async () => {
        resets++;
        t.advance(1000);
      },
    };
    const same = await sampleAsync(
      asynchronous(t.op("base", 0.25)),
      asynchronous(t.op("head", 0.25)),
      options,
    );
    expect(same.ratios).toEqual(Array(10).fill(1));
    // Four warm-ups, two per calibration timing, then two per round.
    expect(resets).toBeGreaterThanOrEqual(4 + 2 + 20);
    const double = await sampleAsync(
      asynchronous(t.op("base", 0.25)),
      asynchronous(t.op("head", 0.5)),
      options,
    );
    expect(double.ratios).toEqual(Array(10).fill(2));
    expect([double.ratio, double.low, double.high]).toEqual([2, 2, 2]);
    expect(double.batch).toBe(16);
  });

  it("sizes asynchronous batches from undisturbed timings too", async () => {
    const t = virtualTime();
    const asynchronous = (op: () => number) => async () => op();
    const s = await sampleAsync(
      asynchronous(t.op("base", 0.25)),
      asynchronous(t.op("head", 0.5, { call: 2, ms: 100 })),
      { rounds: 10, batchMs: 5, warmupMs: 0, clock: t.clock },
    );
    expect(s.batch * 0.5).toBeGreaterThanOrEqual(5);
    expect(s.ratio).toBe(2);
  });
});

describe("Perf-Accepted trailers in a pull request", () => {
  /** Node's modules, untyped: the package has no Node type definitions. */
  const load = <T>(specifier: string): Promise<T> =>
    import(/* @vite-ignore */ specifier) as Promise<T>;

  /** A scratch repository: a main line, and a pull request branched off it. */
  async function scratch() {
    const { execFileSync, spawnSync } = await load<{
      execFileSync(file: string, args: string[], options: object): string;
      spawnSync(
        file: string,
        args: string[],
        options: object,
      ): { stdout: string };
    }>("node:child_process");
    const { mkdtempSync, mkdirSync, writeFileSync } = await load<{
      mkdtempSync(prefix: string): string;
      mkdirSync(path: string, options: object): void;
      writeFileSync(path: string, data: string): void;
    }>("node:fs");
    const { tmpdir } = await load<{ tmpdir(): string }>("node:os");
    const { env } = await load<{ env: Record<string, string | undefined> }>(
      "node:process",
    );
    const dir = mkdtempSync(`${tmpdir()}/tscache-trailers-`);
    // Without git's own variables: under a hook, GIT_DIR names the
    // repository being pushed, and would send every command there.
    const options = {
      cwd: dir,
      encoding: "utf8",
      env: Object.fromEntries(
        Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
      ),
    };
    const git: Git = Object.assign(
      (...args: string[]) => execFileSync("git", args, options).trim(),
      {
        lenient: (...args: string[]) =>
          spawnSync("git", args, options).stdout.trim(),
      },
    );
    git("init", "-q", "-b", "main");
    git("config", "user.email", "bench@example.com");
    git("config", "user.name", "bench");
    git("config", "commit.gpgsign", "false");
    mkdirSync(`${dir}/packages/tscache/src`, { recursive: true });
    const commit = (file: string, message: string) => {
      writeFileSync(`${dir}/${file}`, `${message}\n`);
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    };
    const write = (file: string, text: string) =>
      writeFileSync(`${dir}/${file}`, text);
    return { git, commit, write, dir };
  }

  it("keeps to its scratch repository when git's environment points elsewhere", async () => {
    // A git hook (pre-push runs these tests) exports GIT_DIR for the
    // repository being pushed; inherited, it sends every scratch command
    // there. A decoy stands in for that repository.
    const { env } = await load<{ env: Record<string, string | undefined> }>(
      "node:process",
    );
    const { execFileSync } = await load<{
      execFileSync(file: string, args: string[], options: object): string;
    }>("node:child_process");
    const { mkdtempSync, realpathSync } = await load<{
      mkdtempSync(p: string): string;
      realpathSync(p: string): string;
    }>("node:fs");
    const { tmpdir } = await load<{ tmpdir(): string }>("node:os");
    const decoy = mkdtempSync(`${tmpdir()}/tscache-decoy-`);
    const clean = Object.fromEntries(
      Object.entries(env).filter(([name]) => !name.startsWith("GIT_")),
    );
    execFileSync("git", ["init", "-q", decoy], { env: clean });
    const saved = env.GIT_DIR;
    env.GIT_DIR = `${decoy}/.git`;
    let gitDir: string;
    try {
      const { git, commit, dir } = await scratch();
      commit("packages/tscache/src/engine.ts", "base");
      gitDir = `${git("rev-parse", "--absolute-git-dir")}|${realpathSync(`${dir}/.git`)}`;
    } finally {
      if (saved === undefined) delete env.GIT_DIR;
      else env.GIT_DIR = saved;
    }
    const [used, own] = gitDir.split("|");
    expect(used).toBe(own);
    const decoyLog = execFileSync("git", ["-C", decoy, "rev-list", "--all"], {
      env: clean,
      encoding: "utf8",
    });
    expect(decoyLog).toBe("");
  });

  it("accepts the code it was written for, also on a merge ref, and not a later change", async () => {
    const { git, commit } = await scratch();
    commit("packages/tscache/src/engine.ts", "base");
    git("checkout", "-q", "-b", "pr");
    commit(
      "packages/tscache/src/engine.ts",
      "perf: slower read\n\nPerf-Accepted: read-viewport 1.2 a reason",
    );
    // Main moves on, and the pull request's merge ref merges it in: the
    // base is then main's new tip, and its change voids nothing.
    git("checkout", "-q", "main");
    const mainTip = commit("packages/tscache/src/other.ts", "main moves on");
    git("checkout", "-q", "pr");
    git("merge", "-q", "--no-edit", "main");
    expect(acceptances(mainTip, git)).toEqual(
      new Map([["read-viewport", 1.2]]),
    );

    // A later change to the source in the pull request voids it.
    commit("packages/tscache/src/engine.ts", "perf: slower still");
    const voided: string[] = [];
    expect(acceptances(mainTip, git, (c) => voided.push(c))).toEqual(new Map());
    expect(voided).toHaveLength(1);
  });

  it("is voided when merging the base resolves a source conflict by hand, not by a clean merge", async () => {
    const { git, write } = await scratch();
    write("packages/tscache/src/engine.ts", "one\ntwo\nthree\nfour\nfive\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "pr");
    write("packages/tscache/src/engine.ts", "ONE\ntwo\nthree\nfour\nfive\n");
    git(
      "commit",
      "-q",
      "-am",
      "perf: slower read\n\nPerf-Accepted: read-viewport 1.2 a reason",
    );
    // Main changes the same file elsewhere; merged in, git merges it alone.
    git("checkout", "-q", "main");
    write("packages/tscache/src/engine.ts", "one\ntwo\nthree\nfour\nFIVE\n");
    git("commit", "-q", "-am", "main: five");
    const clean = git("rev-parse", "HEAD");
    git("checkout", "-q", "pr");
    git("merge", "-q", "--no-edit", "main");
    expect(acceptances(clean, git)).toEqual(new Map([["read-viewport", 1.2]]));
    // Main changes the line the pull request changed: a conflict, which
    // the merge resolves with code neither side had.
    git("checkout", "-q", "main");
    write("packages/tscache/src/engine.ts", "uno\ntwo\nthree\nfour\nFIVE\n");
    git("commit", "-q", "-am", "main: uno");
    const conflicting = git("rev-parse", "HEAD");
    git("checkout", "-q", "pr");
    try {
      git("merge", "-q", "--no-edit", "main");
    } catch {
      // Conflict, as intended.
    }
    write(
      "packages/tscache/src/engine.ts",
      "resolved\ntwo\nthree\nfour\nFIVE\n",
    );
    git("commit", "-q", "-am", "merge main");
    expect(acceptances(conflicting, git)).toEqual(new Map());
  });

  it("is not voided by a merge whose only conflict is outside the source", async () => {
    const { git, write } = await scratch();
    write("README.md", "one\n");
    write("packages/tscache/src/engine.ts", "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "pr");
    write("packages/tscache/src/engine.ts", "b\n");
    write("README.md", "pr\n");
    git(
      "commit",
      "-q",
      "-am",
      "perf: slower\n\nPerf-Accepted: read-year 1.3 a reason",
    );
    git("checkout", "-q", "main");
    write("README.md", "main\n");
    git("commit", "-q", "-am", "docs on main");
    const tip = git("rev-parse", "HEAD");
    git("checkout", "-q", "pr");
    try {
      git("merge", "-q", "--no-edit", "main");
    } catch {
      // A conflict in the README only.
    }
    write("README.md", "both\n");
    git("commit", "-q", "-am", "merge main");
    expect(acceptances(tip, git)).toEqual(new Map([["read-year", 1.3]]));
  });

  it("stands for a branch behind its base, against the base it contains", async () => {
    const { git, commit } = await scratch();
    commit("packages/tscache/src/engine.ts", "base");
    git("checkout", "-q", "-b", "pr");
    commit(
      "packages/tscache/src/engine.ts",
      "perf: slower\n\nPerf-Accepted: fill-month 1.2 a reason",
    );
    // Main moves on and the branch has not merged it: a local compare
    // against main's tip.
    git("checkout", "-q", "main");
    const tip = commit("packages/tscache/src/other.ts", "main moves on");
    git("checkout", "-q", "pr");
    expect(acceptances(tip, git)).toEqual(new Map([["fill-month", 1.2]]));
  });

  it("is not voided by a later change outside the source", async () => {
    const { git, commit } = await scratch();
    const base = commit("packages/tscache/src/engine.ts", "base");
    commit(
      "packages/tscache/src/engine.ts",
      "perf: slower put\n\nPerf-Accepted: put-page@bun 1.15 JSC only",
    );
    commit("README.md", "docs: say so");
    expect(acceptances(base, git)).toEqual(new Map([["put-page@bun", 1.15]]));
  });

  it("is voided by uncommitted source, which is what gets benchmarked", async () => {
    const { git, commit, write } = await scratch();
    const base = commit("packages/tscache/src/engine.ts", "base");
    commit(
      "packages/tscache/src/engine.ts",
      "perf: slower read\n\nPerf-Accepted: read-viewport 1.25 a reason",
    );
    write("README.md", "not source\n");
    expect(acceptances(base, git)).toEqual(new Map([["read-viewport", 1.25]]));

    // An unstaged edit, a staged one, an untracked file: each voids it.
    write("packages/tscache/src/engine.ts", "edited\n");
    const voided: string[] = [];
    expect(acceptances(base, git, (c) => voided.push(c))).toEqual(new Map());
    expect(voided).toHaveLength(1);
    git("add", "packages/tscache/src/engine.ts");
    expect(acceptances(base, git)).toEqual(new Map());
    git("checkout", "-q", "HEAD", "--", "packages/tscache/src/engine.ts");
    expect(acceptances(base, git)).toEqual(new Map([["read-viewport", 1.25]]));
    write("packages/tscache/src/added.ts", "new\n");
    expect(acceptances(base, git)).toEqual(new Map());
  });
});

describe("a calibration's tally", () => {
  it("counts quiet runs only, and lists noisy ones apart", () => {
    const quiet = (verdict: string) => ({
      runtime: "bun",
      noisy: false,
      verdicts: { "read-viewport": verdict },
    });
    const reports = [
      ...Array.from({ length: 17 }, () => quiet("regression")),
      ...Array.from({ length: 3 }, () => ({
        runtime: "bun",
        noisy: true,
        verdicts: { "read-viewport": "regression" },
      })),
      quiet("ok"),
    ];
    const { cases, noisy } = tallyCalibration(reports);
    // 17 of 18 quiet runs: the 3 noisy ones count in neither column.
    expect(cases.get("bun")?.get("read-viewport")).toEqual([17, 18]);
    expect(noisy.get("bun")).toBe(3);
  });
});
