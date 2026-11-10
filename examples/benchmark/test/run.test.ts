import { describe, expect, it } from "vitest";
import {
  DEFAULT_LATENCY,
  DEFAULT_RUNS,
  MAX_RUNS,
  parseRunConfig,
  view,
} from "../src/run";
import { MODES } from "../src/workload";

const parse = (input: {
  latency?: string | null;
  runs?: string | null;
  modes?: string | null;
  autorun?: string | null;
}) =>
  parseRunConfig({
    latency: input.latency ?? null,
    runs: input.runs ?? null,
    modes: input.modes ?? null,
    autorun: input.autorun ?? null,
  });

describe("parseRunConfig", () => {
  it("gives the defaults for what is not set", () => {
    expect(parse({})).toEqual({
      ok: true,
      config: {
        latencyMs: DEFAULT_LATENCY,
        runs: DEFAULT_RUNS,
        modes: [...MODES],
        autorun: false,
      },
    });
  });

  it("takes a valid latency, count, mode list and autorun", () => {
    expect(
      parse({
        latency: "50",
        runs: " 3 ",
        modes: "tscache,memo",
        autorun: "1",
      }),
    ).toEqual({
      ok: true,
      config: {
        latencyMs: 50,
        runs: 3,
        modes: ["tscache", "memo"],
        autorun: true,
      },
    });
    expect(parse({ runs: String(MAX_RUNS) }).ok).toBe(true);
  });

  it.each([
    ["blank", ""],
    ["blank but for spaces", "  "],
    ["fractional", "1.5"],
    ["zero", "0"],
    ["negative", "-2"],
    ["above the maximum", String(MAX_RUNS + 1)],
    ["not a number", "five"],
    ["in exponent form", "1e1"],
  ])("rejects a run count that is %s", (_, runs) => {
    const parsed = parse({ runs });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/Runs per mode/);
  });

  it.each([
    ["blank", ""],
    ["not offered", "200"],
    ["fractional", "50.5"],
    ["not a number", "fast"],
  ])("rejects a latency that is %s", (_, latency) => {
    const parsed = parse({ latency });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/latency/);
  });

  it.each([
    ["an unknown mode", "tscache,redis"],
    ["empty", ""],
    ["an empty entry", "memo,,tscache"],
    ["a mode twice", "memo,memo"],
  ])("rejects a mode list with %s", (_, modes) => {
    const parsed = parse({ modes });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(" ")).toMatch(/modes/);
  });

  it("rejects an autorun other than 1", () => {
    expect(parse({ autorun: "yes" }).ok).toBe(false);
  });

  it("names every invalid input at once", () => {
    const parsed = parse({ runs: "", latency: "7", modes: "x" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toHaveLength(3);
  });
});

describe("view", () => {
  const config = {
    latencyMs: 300 as const,
    runs: 2,
    modes: [...MODES],
    autorun: false,
  };

  it("offers results and Copy only once a run is done", () => {
    expect(view({ kind: "idle" })).toEqual({
      status: "ready",
      canRun: true,
      results: undefined,
    });
    expect(view({ kind: "running", config, progress: "running memo" })).toEqual(
      { status: "running memo", canRun: false, results: undefined },
    );
    const results = { config, marker: 1 };
    expect(view({ kind: "done", config, results })).toEqual({
      status: "done",
      canRun: true,
      results,
    });
  });

  it("shows a failure, with no results, whatever failed", () => {
    expect(view({ kind: "failed", error: "Runs per mode is blank" })).toEqual({
      status: "failed: Runs per mode is blank",
      canRun: true,
      results: undefined,
    });
  });
});
