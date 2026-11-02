import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentStore } from "../src/engine/merge";
import {
  all,
  batch,
  type Change,
  config,
  fixture,
  requirePage,
  state,
} from "./persist-test-helpers";

function observed(overrides: Parameters<typeof state>[0] = {}): {
  cache: ReturnType<typeof state>;
  events: (Change | "mutate")[];
} {
  const events: (Change | "mutate")[] = [];
  const cache = state(overrides, {
    onChange: (change) => events.push(change),
    onMutate: () => events.push("mutate"),
  });
  return { cache, events };
}
afterEach(() => vi.restoreAllMocks());
describe("CacheState changes and validated mutations (§4.10.4)", () => {
  it("put reports slots, snapped inward authority and first/version-mismatch ordering", () => {
    const { cache: c, events } = observed({ interval: 10, alignmentOffset: 3 });
    c.put(
      { ...batch([3, 23]), meta: { version: "v1" } },
      { range: { start: -6, end: 32 } },
    );
    expect(events).toEqual([
      { kind: "version" },
      { kind: "write", slots: { start: 0, end: 2 } },
      "mutate",
    ]);
    events.length = 0;
    c.put({ ...batch([13]), meta: { version: "v2" } });
    expect(events).toEqual([
      { kind: "clear" },
      { kind: "version" },
      { kind: "write", slots: { start: 1, end: 1 } },
      "mutate",
    ]);
  });
  it("first watermark reports write clipped below it, watermark then removal; forwards has no removal", () => {
    const { cache: c, events } = observed();
    c.put(batch([0, 7]));
    events.length = 0;
    c.put({ ...batch([1, 6]), meta: { finalizedUntil: 4 } });
    expect(events).toEqual([
      { kind: "write", slots: { start: 1, end: 3 } },
      { kind: "watermark" },
      { kind: "remove", slots: { start: 4, end: Number.MAX_SAFE_INTEGER } },
      "mutate",
    ]);
    events.length = 0;
    c.setFinalizedUntil(6);
    expect(events).toEqual([{ kind: "watermark" }, "mutate"]);
    events.length = 0;
    c.setFinalizedUntil(2);
    expect(events).toEqual([
      { kind: "watermark" },
      { kind: "remove", slots: { start: 2, end: Number.MAX_SAFE_INTEGER } },
      "mutate",
    ]);
  });
  it("invalidate reports snapped slots even when uncovered; clear reports every call", () => {
    const { cache: c, events } = observed({ interval: 10, alignmentOffset: 3 });
    c.invalidate({ start: -6, end: 4 });
    c.clear();
    c.clear();
    expect(events).toEqual([
      { kind: "remove", slots: { start: -1, end: 1 } },
      "mutate",
      { kind: "clear" },
      "mutate",
      { kind: "clear" },
      "mutate",
    ]);
  });
  it("hydrate reports version, first watermark/removal, then applied writes", () => {
    const { cache: c, events } = observed();
    const source = state({ version: "v1", finalizedUntil: 7 });
    source.put(batch([0, 1, 4]));
    c.hydrate(source.snapshot(all));
    expect(events).toEqual([
      { kind: "version" },
      { kind: "watermark" },
      { kind: "remove", slots: { start: 7, end: Number.MAX_SAFE_INTEGER } },
      { kind: "write", slots: { start: 0, end: 4 } },
      "mutate",
    ]);
  });
  it.each([false, true])(
    "a provisional put with range=%s signals mutation without a write",
    (ranged) => {
      const { cache: c, events } = observed({ finalizedUntil: 100 });
      c.put(
        batch([150], [20]),
        ranged ? { range: { start: 150, end: 150 } } : undefined,
      );
      expect(events).toEqual(["mutate"]);
    },
  );
  it("empty put, redundant watermark and skipped/no-op hydrate each signal exactly once", () => {
    const { cache: c, events } = observed({
      version: "v1",
      finalizedUntil: 100,
    });
    c.put(batch([]));
    expect(events.splice(0)).toEqual(["mutate"]);
    c.setFinalizedUntil(100);
    expect(events.splice(0)).toEqual(["mutate"]);
    const foreign = state({ version: "v2" });
    foreign.put(batch([0]));
    c.hydrate(foreign.snapshot(all));
    expect(events.splice(0)).toEqual(["mutate"]);
    const own = state({ version: "v1" });
    own.put(batch([0]));
    c.hydrate(own.snapshot(all));
    events.length = 0;
    c.hydrate(own.snapshot(all));
    expect(events).toEqual(["mutate"]);
  });
  it("validation rejects signal neither hook; reads, snapshots and coverage never signal", () => {
    const { cache: c, events } = observed();
    for (const action of [
      () => c.put(batch([1, 0])),
      () => c.hydrate({} as never),
      () => c.invalidate({ start: 1, end: 0 }),
      () => c.setFinalizedUntil(Number.NaN),
    ])
      expect(action).toThrow();
    c.get(all);
    c.snapshot(all);
    c.coverage(all);
    expect(events).toEqual([]);
  });
  it("failed write withdraws its slots and signals onMutate before rethrow", () => {
    const { cache: c, events } = observed();
    c.put(batch([0, 3]));
    events.length = 0;
    const error = new RangeError("planted allocation failure");
    vi.spyOn(SegmentStore.prototype, "put").mockImplementation(() => {
      throw error;
    });
    expect(() => c.put(batch([1, 2]))).toThrow(error);
    expect(events).toEqual([
      { kind: "remove", slots: { start: 1, end: 2 } },
      "mutate",
    ]);
    expect(c.coverage({ start: 1, end: 2 })).toEqual([]);
  });
  it("restore signals only a retained creation watermark, never onMutate/write", () => {
    const { cache: c, events } = observed({ finalizedUntil: 20 });
    c.restore(fixture({ finalizedUntil: 10 }, [0]));
    expect(events).toEqual([{ kind: "watermark" }]);
    const quiet = observed();
    quiet.cache.restore(fixture());
    expect(quiet.events).toEqual([]);
    expect(requirePage(fixture()).cacheId).toBe(config().id);
  });
});
