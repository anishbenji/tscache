import { describe, expect, it } from "vitest";
import {
  anchorFor,
  exactKeyRequests,
  INTERVAL,
  NEW_BARS,
  SCREEN,
  TABS,
  views,
  workload,
} from "../src/workload";

const HOUR = 60 * 60_000;
const NOW = Date.UTC(2026, 10, 9, 8, 30);

describe("anchorFor", () => {
  it("is yesterday at 12:00 UTC, on the grid and in final history", () => {
    expect(anchorFor(NOW)).toBe(Date.UTC(2026, 10, 8, 12));
    expect(anchorFor(NOW) % INTERVAL).toBe(0);
    // The same anchor all day, so a page's runs never straddle two.
    expect(anchorFor(Date.UTC(2026, 10, 9, 23, 59))).toBe(anchorFor(NOW));
  });
});

describe("views", () => {
  const end = anchorFor(NOW);
  const [load, ...rest] = views(end);
  const scrolls = rest.slice(0, 5);
  const [zoomOut, zoomIn, back] = rest.slice(5);

  it("opens on the newest screen and scrolls back five, edge to edge", () => {
    expect(views(end)).toHaveLength(9);
    expect(load?.range).toEqual({
      start: end - (SCREEN - 1) * INTERVAL,
      end,
    });
    let previous = load?.range;
    for (const { step, range } of scrolls) {
      expect(step).toBe("scroll back");
      expect((range.end - range.start) / INTERVAL + 1).toBe(SCREEN);
      expect(range.end).toBe((previous?.start ?? 0) - INTERVAL);
      previous = range;
    }
  });

  it("zooms out to four screens around the fifth, back in, and returns", () => {
    const fifth = scrolls.at(-1)?.range;
    expect(zoomOut?.range.end).toBeGreaterThan(fifth?.end ?? 0);
    expect(zoomOut?.range.start).toBeLessThan(fifth?.start ?? 0);
    expect((zoomOut?.range.end ?? 0) - (zoomOut?.range.start ?? 0)).toBe(
      4 * SCREEN * INTERVAL - INTERVAL,
    );
    expect(zoomIn?.range).toEqual(fifth);
    expect(back?.range).toEqual(load?.range);
    expect(zoomOut?.range.start).toBeGreaterThan(end - 40 * HOUR);
  });
});

describe("workload", () => {
  it("runs phase two on the same views, moved on by the newest bars", () => {
    const { one, three } = workload(anchorFor(NOW));
    expect(three).toHaveLength(one.length);
    for (const [i, view] of three.entries()) {
      expect(view.step).toBe(one[i]?.step);
      expect(view.range.start - (one[i]?.range.start ?? 0)).toBe(
        NEW_BARS * INTERVAL,
      );
    }
  });
});

describe("exactKeyRequests", () => {
  const plan = workload(anchorFor(NOW));
  // Each tab's nine views hold two repeats: zooming back in, and returning.
  const distinct = plan.one.length - 2;

  it("per tab, fetches every distinct range once in each tab", () => {
    // Phase two's ranges are all shifted, so tab one's cache has none.
    expect(exactKeyRequests(plan, "per tab")).toEqual({
      one: distinct,
      three: TABS * distinct,
      total: (1 + TABS) * distinct,
    });
  });

  it("shared by the tabs, fetches every distinct range once", () => {
    expect(exactKeyRequests(plan, "shared")).toEqual({
      one: distinct,
      three: distinct,
      total: 2 * distinct,
    });
  });

  it("without the shift, phase two is served from tab one's cache", () => {
    const still = { one: plan.one, three: plan.one };
    expect(exactKeyRequests(still, "shared").three).toBe(0);
    expect(exactKeyRequests(still, "per tab").three).toBe(
      (TABS - 1) * distinct,
    );
  });
});
