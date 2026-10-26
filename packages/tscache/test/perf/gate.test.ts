import { describe, expect, it } from "vitest";
import {
  acceptances,
  flagged,
  GATE,
  type Git,
  noisy,
  trailers,
  verdictOf,
} from "../../bench/gate";
import { medianRanks, type Sample, sample } from "../../bench/sample";

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
  });

  it("finds no difference between the same operation and itself, and a large one", () => {
    let x = 0;
    const work = () => {
      for (let i = 0; i < 2000; i++) x = (x + i) % 9973;
      return x;
    };
    const twice = () => work() + work();
    const options = { rounds: 10, batchMs: 5, warmupMs: 20 };
    const same = sample(work, work, options);
    expect(same.ratio).toBeGreaterThan(0.7);
    expect(same.ratio).toBeLessThan(1.4);
    const double = sample(work, twice, options);
    expect(double.ratio).toBeGreaterThan(1.5);
  });
});

describe("Perf-Accepted trailers in a pull request", () => {
  /** Node's modules, untyped: the package has no Node type definitions. */
  const load = <T>(specifier: string): Promise<T> =>
    import(/* @vite-ignore */ specifier) as Promise<T>;

  /** A scratch repository: a main line, and a pull request branched off it. */
  async function scratch() {
    const { execFileSync } = await load<{
      execFileSync(file: string, args: string[], options: object): string;
    }>("node:child_process");
    const { mkdtempSync, mkdirSync, writeFileSync } = await load<{
      mkdtempSync(prefix: string): string;
      mkdirSync(path: string, options: object): void;
      writeFileSync(path: string, data: string): void;
    }>("node:fs");
    const { tmpdir } = await load<{ tmpdir(): string }>("node:os");
    const dir = mkdtempSync(`${tmpdir()}/tscache-trailers-`);
    const git: Git = (...args) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
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
    return { git, commit };
  }

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
});
