import { describe, expect, it } from "vitest";
import { chartKindOf } from "../src/chart/load";
import { keptRange, moved } from "../src/chart/view";
import { MINUTE, openingRange, readRange } from "../src/market";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 30);

describe("readRange", () => {
  it("reads a screen more on each side, never past now", () => {
    const visible = { start: NOW - 60 * MINUTE, end: NOW - 30 * MINUTE };
    expect(readRange(visible, NOW)).toEqual({
      start: NOW - 90 * MINUTE,
      end: NOW,
    });
    const history = { start: NOW - 600 * MINUTE, end: NOW - 500 * MINUTE };
    expect(readRange(history, NOW)).toEqual({
      start: NOW - 700 * MINUTE,
      end: NOW - 400 * MINUTE,
    });
  });

  it("stays a valid range when the view is past now", () => {
    const future = { start: NOW + 60 * MINUTE, end: NOW + 120 * MINUTE };
    const range = readRange(future, NOW);
    expect(range.start).toBeLessThanOrEqual(range.end);
    expect(range.end).toBe(NOW);
  });

  it("opens on the last six hours", () => {
    expect(openingRange(NOW)).toEqual({ start: NOW - 360 * MINUTE, end: NOW });
  });
});

describe("keptRange", () => {
  const shown = { start: 1000, end: 2000 };

  it("follows the newest bar while the view shows it", () => {
    expect(keptRange(shown, 1900, 1960)).toEqual({ start: 1060, end: 2060 });
  });

  it("stays put while the view is in history", () => {
    expect(keptRange(shown, 2500, 2560)).toEqual(shown);
  });
});

describe("moved", () => {
  it("ignores a change within half an interval", () => {
    const range = { start: 0, end: 10 * MINUTE };
    expect(moved(undefined, range, MINUTE)).toBe(true);
    expect(moved(range, { start: 20_000, end: 10 * MINUTE }, MINUTE)).toBe(
      false,
    );
    expect(moved(range, { start: 40_000, end: 10 * MINUTE }, MINUTE)).toBe(
      true,
    );
  });
});

describe("chartKindOf", () => {
  it("takes ?chart=, defaulting to Lightweight Charts", () => {
    expect(chartKindOf("?chart=uplot")).toBe("uplot");
    expect(chartKindOf("?chart=other")).toBe("lightweight");
    expect(chartKindOf("")).toBe("lightweight");
  });
});
