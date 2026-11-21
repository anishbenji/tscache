import { describe, expect, it } from "vitest";
import { chartKindOf } from "../src/chart/load";
import { keptRange, moved } from "../src/chart/view";
import {
  formingBar,
  MINUTE,
  market,
  oneBarPast,
  openingRange,
  readRange,
} from "../src/market";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 30);

describe("readRange", () => {
  // NOW lies 30 s into the bar that opened at FORMING.
  const FORMING = NOW - 30_000;

  it("reads a screen more on each side, never past the bar forming now", () => {
    const visible = { start: NOW - 60 * MINUTE, end: NOW - 30 * MINUTE };
    expect(readRange(visible, NOW)).toEqual({
      start: NOW - 90 * MINUTE,
      end: FORMING,
    });
    const history = { start: NOW - 600 * MINUTE, end: NOW - 500 * MINUTE };
    expect(readRange(history, NOW)).toEqual({
      start: NOW - 700 * MINUTE,
      end: NOW - 400 * MINUTE,
    });
  });

  it("ends on the grid whenever it reaches now", () => {
    // An end between grid points snaps outward to the next one, a bar that
    // cannot exist yet; a read crossing a minute boundary then fetches
    // three minutes (fix 26). Every end that reaches now is a bar's start.
    for (const now of [FORMING, FORMING + 1, NOW, FORMING + MINUTE - 1]) {
      const range = readRange(openingRange(now), now);
      expect(range.end).toBe(FORMING);
    }
  });

  it("stays a valid range when the view is past now", () => {
    const future = { start: NOW + 60 * MINUTE, end: NOW + 120 * MINUTE };
    const range = readRange(future, NOW);
    expect(range.start).toBeLessThanOrEqual(range.end);
    expect(range.end).toBe(FORMING);
  });

  it("opens on the last six hours", () => {
    expect(openingRange(NOW)).toEqual({ start: NOW - 360 * MINUTE, end: NOW });
  });
});

describe("formingBar", () => {
  it("is the start of the bar forming at a time, on the market's grid", () => {
    expect(formingBar(NOW)).toBe(NOW - 30_000);
    expect(formingBar(NOW - 30_000)).toBe(NOW - 30_000);
    expect(formingBar(NOW + 29_999)).toBe(NOW - 30_000);
    expect(formingBar(NOW + 30_000)).toBe(NOW + 30_000);
  });

  it("honours the grid's alignment offset", () => {
    const config = { ...market, alignmentOffset: 15_000 };
    expect(formingBar(NOW, config)).toBe(NOW - 15_000);
    expect(formingBar(NOW - 16_000, config)).toBe(NOW - 75_000);
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

describe("oneBarPast and formingBar on the market's grid", () => {
  it("steps by the market's fixed interval, from any instant", () => {
    expect(oneBarPast(NOW)).toBe(NOW + MINUTE);
    expect(oneBarPast(NOW - 30_000)).toBe(NOW - 30_000 + MINUTE);
    expect(formingBar(NOW)).toBe(NOW - 30_000);
  });

  it("steps by the length of the slot that holds the instant on a calendar grid", () => {
    const HOUR = 60 * MINUTE;
    const sessions = {
      ...market,
      id: "equity/ACME/1d",
      interval: { unit: "day", zone: "America/New_York", at: "09:30" },
    } as const;
    // New York's clocks go forward on 8 March 2026: the session of the 7th
    // opens at 14:30 UTC and the next one 23 hours later.
    const open7 = Date.UTC(2026, 2, 7, 14, 30);
    expect(oneBarPast(open7, sessions)).toBe(open7 + 23 * HOUR);
    expect(oneBarPast(open7 + 5 * HOUR, sessions)).toBe(open7 + 28 * HOUR);
    const open9 = Date.UTC(2026, 2, 9, 13, 30);
    expect(oneBarPast(open9 + HOUR, sessions)).toBe(open9 + 25 * HOUR);
    expect(formingBar(open9 + 6 * HOUR, sessions)).toBe(open9);
    // A month is as long as its calendar says.
    const months = { ...market, id: "m", interval: { unit: "month" } } as const;
    expect(oneBarPast(Date.UTC(2026, 1, 10), months)).toBe(
      Date.UTC(2026, 1, 10) + 28 * 24 * HOUR,
    );
  });
});
