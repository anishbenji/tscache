import { describe, expect, it } from "vitest";
import type { SlotRange } from "../src/grid";
import { planFetches, planRound } from "../src/orchestrator/orchestrator";

import { roundModel } from "./inflight-plan-model";

// Implementer tests (architecture §4.9, step 36 R1-1): the fetch plan,
// computed in linear sweeps, against a slot-by-slot model of the same
// rules on random inputs.

const grid = { interval: 10, alignmentOffset: 3 };

/** A seeded generator, so a failure reproduces. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    return state / 2 ** 32;
  };
}

/** Runs of consecutive slots in `slots` (ascending). */
function runs(slots: number[]): SlotRange[] {
  const out: SlotRange[] = [];
  for (const slot of slots) {
    const last = out.at(-1);
    if (last !== undefined && slot === last.end + 1) last.end = slot;
    else out.push({ start: slot, end: slot });
  }
  return out;
}

/** Random ascending ranges inside `span`; disjoint and, if `apart`, non-adjacent. */
function rangesIn(span: SlotRange, next: () => number, apart: boolean) {
  const slots: number[] = [];
  for (let s = span.start; s <= span.end; s++) if (next() < 0.5) slots.push(s);
  const out = runs(slots);
  return apart ? out : out.flatMap((r) => splitAt(r, next));
}

/** `r`, sometimes cut into adjacent pieces (blocked fetches may touch). */
function splitAt(r: SlotRange, next: () => number): SlotRange[] {
  if (r.end === r.start || next() < 0.5) return [r];
  const at = r.start + Math.floor(next() * (r.end - r.start));
  return [
    { start: r.start, end: at },
    { start: at + 1, end: r.end },
  ];
}

/**
 * The rules as §4.9 states them, slot by slot: the request's slots outside
 * the coverage and the blocked ranges, as runs; each run extended one slot
 * into coverage it abuts; runs that touch or overlap merged.
 */
function model(
  request: SlotRange,
  around: SlotRange[],
  blocked: SlotRange[],
): SlotRange[] {
  const inAny = (rs: SlotRange[], s: number) =>
    rs.some((r) => r.start <= s && s <= r.end);
  const open: number[] = [];
  for (let s = request.start; s <= request.end; s++) {
    if (!inAny(around, s) && !inAny(blocked, s)) open.push(s);
  }
  const out: SlotRange[] = [];
  for (const run of runs(open)) {
    const start = inAny(around, run.start - 1) ? run.start - 1 : run.start;
    const end = inAny(around, run.end + 1) ? run.end + 1 : run.end;
    const last = out.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({ start, end });
    }
  }
  return out;
}

describe("the fetch plan", () => {
  it("matches the slot-by-slot model on random coverage and blocked ranges", () => {
    const next = random(36);
    for (let i = 0; i < 2000; i++) {
      const start = Math.floor(next() * 20);
      const request = { start, end: start + Math.floor(next() * 40) };
      const probe = { start: request.start - 1, end: request.end + 1 };
      const around = rangesIn(probe, next, true);
      const blocked = next() < 0.5 ? [] : rangesIn(request, next, false);
      expect(planFetches(request, around, blocked, grid)).toEqual(
        model(request, around, blocked),
      );
    }
  });

  it("plans nothing for a covered request, and the whole of an empty one", () => {
    const request = { start: 5, end: 9 };
    expect(planFetches(request, [{ start: 4, end: 10 }], [], grid)).toEqual([]);
    expect(planFetches(request, [], [], grid)).toEqual([request]);
    expect(planFetches(request, [], [request], grid)).toEqual([]);
  });
});

// Step 44 contract tests: this named export is deliberately absent until N31.
describe("§4.9.1 round planning", () => {
  it("T1: matches a slot model on 2,000 cases, including nested in-flight ranges", () => {
    const next = random(44);
    for (let i = 0; i < 2000; i++) {
      const start = Math.floor(next() * 40) - 20;
      const request = { start, end: start + Math.floor(next() * 40) };
      const probe = { start: start - 1, end: request.end + 1 };
      const around = rangesIn(probe, next, true);
      const blocked = rangesIn(request, next, false);
      const inflight = Array.from({ length: Math.floor(next() * 12) }, () => {
        const a =
          probe.start - 5 + Math.floor(next() * (probe.end - probe.start + 10));
        return { start: a, end: a + Math.floor(next() * 35) };
      }).sort((a, b) => a.start - b.start);
      const got = planRound(request, around, inflight, blocked, grid);
      expect(got, `case ${i}`).toEqual(
        roundModel(request, around, inflight, blocked),
      );
      const inAny = (rs: SlotRange[], s: number) =>
        rs.some((r) => r.start <= s && s <= r.end);
      for (const fetch of got.fetch) {
        for (let s = fetch.start; s <= fetch.end; s++) {
          if (!inAny(around, s)) {
            expect(inAny(inflight, s), `in-flight slot ${s}, case ${i}`).toBe(
              false,
            );
            expect(inAny(blocked, s), `blocked slot ${s}, case ${i}`).toBe(
              false,
            );
          }
        }
        for (const busy of inflight) {
          const shared = Math.max(
            0,
            Math.min(fetch.end, busy.end) -
              Math.max(fetch.start, busy.start) +
              1,
          );
          expect(shared).toBeLessThanOrEqual(2);
        }
      }
      const union: SlotRange[] = [];
      for (const r of inflight) {
        const last = union.at(-1);
        if (last && r.start <= last.end + 1)
          last.end = Math.max(last.end, r.end);
        else union.push({ ...r });
      }
      const meeting = roundModel(request, around, union, blocked).join.length;
      const ordinary = planFetches(request, around, blocked, grid).length;
      expect(got.fetch.length).toBeLessThanOrEqual(ordinary + meeting);
      expect(meeting).toBeLessThanOrEqual(got.join.length);
    }
  });

  it("T2: reduces to planFetches on the same 2,000 random inputs without in-flight ranges", () => {
    const next = random(44);
    for (let i = 0; i < 2000; i++) {
      const start = Math.floor(next() * 40) - 20;
      const request = { start, end: start + Math.floor(next() * 40) };
      const around = rangesIn(
        { start: start - 1, end: request.end + 1 },
        next,
        true,
      );
      const blocked = rangesIn(request, next, false);
      // Consume the same random in-flight generation as T1.
      const count = Math.floor(next() * 12);
      for (let j = 0; j < count; j++) {
        next();
        next();
      }
      expect(planRound(request, around, [], blocked, grid)).toEqual({
        fetch: planFetches(request, around, blocked, grid),
        join: [],
      });
    }
  });

  it("T3: handles inclusive ends, adjacent, singleton, containing and wholly covered ranges", () => {
    const r = { start: 10, end: 19 };
    for (const [busy, fetch, join] of [
      [[0, 9], [[10, 19]], []],
      [[0, 10], [[11, 19]], [0]],
      [
        [12, 12],
        [
          [10, 11],
          [13, 19],
        ],
        [0],
      ],
      [[5, 25], [], [0]],
    ] as const) {
      expect(planRound(r, [], [pair(busy)], [], grid)).toEqual({
        fetch: fetch.map(pair),
        join,
      });
    }
    expect(planRound(r, [r], [r], [], grid)).toEqual({ fetch: [], join: [] });
  });

  it("T4: extends and bridges covered in-flight slots, up to two shared slots", () => {
    for (const [r, coverage, busy, fetch] of [
      [[10, 19], [0, 9], [5, 9], [[9, 19]]],
      [[10, 19], [15, 15], [15, 15], [[10, 19]]],
      [[10, 19], [14, 15], [14, 15], [[10, 19]]],
      [
        [10, 19],
        [14, 16],
        [14, 16],
        [
          [10, 14],
          [16, 19],
        ],
      ],
      [[-1, 2], [0, 1], [0, 1], [[-1, 2]]],
    ] as const) {
      expect(
        planRound(pair(r), [pair(coverage)], [pair(busy)], [], grid),
      ).toEqual({ fetch: fetch.map(pair), join: [] });
    }
  });

  it("T5: excludes uncovered blocked slots from joining and fetching, but keeps covered flanks", () => {
    expect(
      planRound(pair([10, 19]), [], [pair([12, 13])], [pair([11, 14])], grid),
    ).toEqual({ fetch: [pair([10, 10]), pair([15, 19])], join: [] });
    expect(
      planRound(pair([0, 2]), [pair([0, 0])], [], [pair([0, 0])], grid),
    ).toEqual({ fetch: [pair([0, 2])], join: [] });
  });
});

function pair([start, end]: readonly [number, number]): SlotRange {
  return { start, end };
}
