import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkE2e, writeE2e } from "./bench";
import type { E2eOutcome, E2eResult } from "./bench-e2e";

const passed: E2eResult = {
  name: "handshake-first-read",
  what: "a new tab's first read",
  sample: {
    ratios: [1, 1.1],
    ratio: 1.05,
    low: 1,
    high: 1.1,
    baseMs: 2,
    headMs: 2.1,
    batch: 1,
  },
};

const failed: E2eOutcome = {
  results: [passed],
  failures: [{ scenario: "fast-scroll", message: "served 7502 bars" }],
};

const run = {
  base: "a".repeat(40),
  baseRef: "origin/main",
  head: "b".repeat(40),
  fetchers: { base: "columns", head: "columns" },
} as const;

describe("writeE2e", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("writes the passing timings and the failures, then fails the run", () => {
    dir = mkdtempSync(join(tmpdir(), "tscache-bench-e2e-"));
    const { summary, code } = writeE2e(dir, { ...run, outcome: failed });
    expect(code).toBe(1);
    const record = JSON.parse(readFileSync(join(dir, "e2e.json"), "utf8"));
    expect(record).toEqual({
      schema: 1,
      base: run.base,
      head: run.head,
      fetchers: run.fetchers,
      results: [passed],
      failed: [{ scenario: "fast-scroll", message: "served 7502 bars" }],
    });
    const written = readFileSync(join(dir, "e2e-summary.md"), "utf8");
    expect(written).toBe(`${summary}\n`);
    expect(summary).toContain("| `handshake-first-read` | 2.00 ms | 2.10 ms |");
    expect(summary).toContain("`fast-scroll`: served 7502 bars");
  });

  it("succeeds with an empty failed list when every scenario passes", () => {
    dir = mkdtempSync(join(tmpdir(), "tscache-bench-e2e-"));
    const outcome = { results: [passed], failures: [] };
    const { summary, code } = writeE2e(dir, { ...run, outcome });
    expect(code).toBe(0);
    const record = JSON.parse(readFileSync(join(dir, "e2e.json"), "utf8"));
    expect(record.results).toEqual([passed]);
    expect(record.failed).toEqual([]);
    expect(summary).not.toContain("Failed");
  });
});

describe("checkE2e", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  const ok: E2eResult = { name: "a", what: "a", value: 3, expected: 3 };

  it("fails the smoke when a scenario failed, though every result checks", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outcome = {
      results: [ok],
      failures: [{ scenario: "b", message: "b broke" }],
    };
    expect(checkE2e(outcome)).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "1 of 2 e2e scenarios failed: b: b broke",
    );
  });

  it("fails on a wrong result and passes when every result checks", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const wrong = { ...ok, name: "w", value: 4 };
    expect(checkE2e({ results: [ok, wrong], failures: [] })).toBe(1);
    expect(checkE2e({ results: [ok], failures: [] })).toBe(0);
  });
});
