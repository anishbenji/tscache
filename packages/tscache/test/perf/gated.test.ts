import { describe, expect, it } from "vitest";
import { cases } from "../../bench/cases";
import { failing, gatedCases } from "../../bench/gate";

// Which timing regressions fail the bench job (docs/benchmarking.md, "The
// gate"): only those of the cases bench/gated.json lists for the runtime,
// the ones calibration showed the gate judges reliably. Every other case,
// and every runtime the file leaves out, reports.

/** Node's modules, untyped: the package has no Node type definitions. */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;

const gated = gatedCases({ bun: ["read-viewport", "put-page"], chromium: [] });

function report(
  runtime: string,
  verdicts: Record<string, string>,
  noisy = false,
) {
  return { runtime, noisy, verdicts };
}

describe("the per-case gate", () => {
  it("fails on a confirmed regression of a gated case", () => {
    const bun = report("bun", {
      "read-viewport": "regression",
      "put-page": "ok",
    });
    expect(failing(bun, gated)).toEqual(["read-viewport"]);
  });

  it("only reports a regression of a case the file does not list", () => {
    const bun = report("bun", { "read-year": "regression", "put-page": "ok" });
    expect(failing(bun, gated)).toEqual([]);
  });

  it("lists every gated regression, and none that is flagged or accepted", () => {
    const bun = report("bun", {
      "read-viewport": "regression",
      "put-page": "regression",
      "read-year": "regression",
    });
    expect(failing(bun, gated)).toEqual(["read-viewport", "put-page"]);
    const settled = report("bun", {
      "read-viewport": "flagged",
      "put-page": "accepted",
    });
    expect(failing(settled, gated)).toEqual([]);
  });

  it("only reports in a runtime with no gated case, or one the file leaves out", () => {
    const slow = { "read-viewport": "regression" };
    expect(failing(report("chromium", slow), gated)).toEqual([]);
    expect(failing(report("node", slow), gated)).toEqual([]);
  });

  it("fails nothing when the A/A control was noisy", () => {
    const bun = report("bun", { "read-viewport": "regression" }, true);
    expect(failing(bun, gated)).toEqual([]);
  });

  it("refuses a file that is not runtimes to lists of case names", () => {
    expect(() => gatedCases([])).toThrow(/gated\.json/);
    expect(() => gatedCases({ bun: "read-viewport" })).toThrow(/bun/);
    expect(() => gatedCases({ bun: [1] })).toThrow(/bun/);
    expect(() =>
      gatedCases({ bun: ["read-viewport", "read-viewport"] }),
    ).toThrow(/twice/);
  });

  it("refuses Node, which only reports, and runtimes the bench does not run", () => {
    expect(() => gatedCases({ node: ["read-viewport"] })).toThrow(/node/);
    expect(() => gatedCases({ safari: [] })).toThrow(/safari/);
  });
});

describe("bench/gated.json", () => {
  it("names only cases the bench runs", async () => {
    const { readFileSync } = await load<{
      readFileSync(path: URL, encoding: "utf8"): string;
    }>("node:fs");
    const path = new URL("../../bench/gated.json", import.meta.url);
    const file = gatedCases(JSON.parse(readFileSync(path, "utf8")));
    const known = new Set(cases().map((c) => c.name));
    for (const [runtime, names] of file) {
      for (const name of names) {
        expect(known.has(name), `${runtime}: ${name}`).toBe(true);
      }
    }
  });
});
