import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { TscacheError } from "../src/errors";
import {
  all,
  batch,
  type Change,
  config,
  fixture,
  recordsOf,
  requireCache,
  state,
  stateRecords,
} from "./persist-test-helpers";

describe("restore into memory that knows nothing (§4.10.5)", () => {
  it("round trips covered points, negative pages, NaN, version and watermark without changes (a)", () => {
    const source = new Engine();
    source.cache(config({ version: "v1", finalizedUntil: 20 }));
    source.put("persist", batch([-1, 0, 3, 4, 7], [1, Number.NaN, 3, 4, 7]));
    source.invalidate("persist", { start: 1, end: 2 });
    const records = recordsOf(source);
    const changes: Change[] = [];
    const target = state(
      {},
      {
        onChange: (c) => changes.push(c),
        onMutate: () => {
          throw new Error("restore must not mutate-hook");
        },
      },
    );
    expect(target.restore(records)).toEqual({
      applied: source.coverage("persist", all),
      rewrite: false,
    });
    expect(target.get(all)).toEqual(source.get("persist", all));
    expect(changes).toEqual([]);
    expect(target.version).toBe("v1");
    expect(target.finalizedUntil).toBe(20);
    expect(stateRecords(target)).toEqual(records);
    const second = state();
    second.restore(records);
    expect(second.snapshot(all)).toEqual(target.snapshot(all));
    expect(() => target.restore(records)).toThrow(/^restore:/);
  });
  it.each([
    "covered gap",
    "covered point",
    "uncovered point",
    "provisional R1-1",
  ])("throws atomically if target holds %s (b)", (kind) => {
    const target = state(
      kind === "provisional R1-1" ? { finalizedUntil: 100 } : {},
    );
    if (kind === "covered gap")
      target.put(batch([]), { range: { start: 0, end: 0 } });
    else {
      target.put(batch([150], [20]));
      if (kind === "uncovered point")
        target.invalidate({ start: 150, end: 150 });
    }
    const before = target.snapshot(all);
    const stored = fixture({ finalizedUntil: 200 }, [150]);
    for (const page of stored.pages)
      for (const segment of page.snapshot.segments)
        for (const field of segment.fields)
          new Float64Array(field.data).fill(10);
    expect(() => target.restore(stored)).toThrow(TscacheError);
    expect(() => target.restore(stored)).toThrow(/^restore:/);
    expect(target.snapshot(all)).toEqual(before);
    if (kind === "provisional R1-1") {
      expect(target.finalizedUntil).toBe(100);
      expect(target.get({ start: 150, end: 150 }).fields.value).toEqual(
        new Float64Array([20]),
      );
      expect(target.coverage(all)).toEqual([]);
    }
  });
  it.each([
    { c: undefined, r: undefined, apply: true },
    { c: "v1", r: "v1", apply: true },
    { c: undefined, r: "v1", apply: true },
    { c: "v1", r: undefined, apply: false },
    { c: "v1", r: "v2", apply: false },
  ])("version C=$c R=$r (c)", ({ c, r, apply }) => {
    const target = state(c === undefined ? {} : { version: c });
    const stored = fixture(r === undefined ? {} : { version: r }, [0]);
    expect(target.restore(stored)).toEqual({
      applied: apply ? [{ start: 0, end: 0 }] : [],
      rewrite: !apply,
    });
    expect(target.version).toBe(c ?? r);
    expect(target.get(all).timestamps.length).toBe(apply ? 1 : 0);
  });
  it("confirmed-gap pages restore authority without points or misses (e)", () => {
    const source = new Engine();
    source.cache(config());
    source.put("persist", batch([]), { range: { start: -1, end: 4 } });
    const target = state();
    expect(target.restore(recordsOf(source))).toEqual({
      applied: [{ start: -1, end: 4 }],
      rewrite: false,
    });
    expect(target.get({ start: -1, end: 4 })).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [{ start: -1, end: 4 }],
      misses: [],
    });
  });
  it.each([
    { creation: 20, stored: 10, changes: [{ kind: "watermark" }] },
    { creation: 5, stored: 10, changes: [] },
  ])(
    "creation watermark $creation versus record $stored (f)",
    ({ creation, stored, changes: expected }) => {
      const changes: Change[] = [];
      const target = state(
        { finalizedUntil: creation },
        { onChange: (c) => changes.push(c) },
      );
      const records = fixture({ finalizedUntil: stored }, [0, 4]);
      expect(target.restore(records).rewrite).toBe(false);
      expect(target.finalizedUntil).toBe(Math.max(creation, stored));
      expect(changes).toEqual(expected);
    },
  );
  it("a watermark absent on disk is clipped by creation watermark and requires rewrite (f)", () => {
    const changes: Change[] = [];
    const target = state(
      { finalizedUntil: 3 },
      { onChange: (c) => changes.push(c) },
    );
    expect(target.restore(fixture({}, [0, 4]))).toEqual({
      applied: [{ start: 0, end: 2 }],
      rewrite: true,
    });
    expect(target.get(all).timestamps).toEqual(new Float64Array([0]));
    expect(changes).toEqual([{ kind: "watermark" }]);
  });
  it("merges adjacent applied parts across page boundaries", () => {
    const records = fixture({}, [-1, 0, 3, 4]);
    const target = state();
    expect(target.restore(records)).toEqual({
      applied: [{ start: -1, end: 4 }],
      rewrite: false,
    });
    expect(requireCache(records).config.segmentSlotCap).toBe(4);
  });
});
