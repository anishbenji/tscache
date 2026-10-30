import { describe, expect, it } from "vitest";
import type { SlotRange } from "../src/grid";
import { planFetches } from "../src/orchestrator/orchestrator";

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
