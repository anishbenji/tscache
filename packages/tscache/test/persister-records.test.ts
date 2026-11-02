import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import type { PageRecord } from "../src/persist/records";
import { fakeTime, finish, opened } from "./persist-harness";
import {
  all,
  batch,
  config,
  expectRecords,
  recordsOf,
  requireCache,
  requirePage,
  state,
} from "./persist-test-helpers";

fakeTime();
describe("canonical persisted records (§4.10.2)", () => {
  it("negative floor pages, cap−1/cap fenceposts, hulls and page envelopes", async () => {
    const h = await opened({
      interval: 10,
      alignmentOffset: 3,
      version: "v1",
      finalizedUntil: 203,
    });
    h.engine.put("persist", batch([-47, -37, -7, 3, 33, 43, 73, 83]));
    h.engine.invalidate("persist", { start: 13, end: 23 });
    await finish(h.persister.flush());
    const stored = h.store.records("persist");
    expectRecords(stored, h.engine);
    expect(stored.pages.map((p: PageRecord) => p.page)).toEqual([
      -2, -1, 0, 1, 2,
    ]);
    expect(stored.pages.map((p: PageRecord) => p.snapshot.range)).toEqual([
      { start: -47, end: -47 },
      { start: -37, end: -7 },
      { start: 3, end: 33 },
      { start: 43, end: 73 },
      { start: 83, end: 83 },
    ]);
    expect(requireCache(stored)).toEqual({
      cacheId: "persist",
      format: 1,
      config: {
        interval: 10,
        alignmentOffset: 3,
        fields: { value: "f64" },
        gapSplitK: 4,
        segmentSlotCap: 4,
        warnOnOverlapDiff: false,
      },
      version: "v1",
      finalizedUntil: 203,
    });
    for (const page of stored.pages)
      expect(page.snapshot).not.toHaveProperty("finalizedUntil");
  });
  it("stores no invalidated or originally provisional point inside a covered hull", async () => {
    const h = await opened({ segmentSlotCap: 16, finalizedUntil: 2 });
    h.engine.put("persist", batch([0, 1, 2, 3]));
    h.engine.setFinalizedUntil("persist", 10);
    h.engine.put("persist", batch([7]));
    h.engine.invalidate("persist", { start: 1, end: 1 });
    await finish(h.persister.flush());
    const stored = h.store.records("persist");
    expectRecords(stored, h.engine);
    const target = state({ segmentSlotCap: 16 });
    target.restore(stored);
    expect(target.get(all).timestamps).toEqual(new Float64Array([0, 7]));
    expect(requirePage(stored).snapshot.range).toEqual({ start: 0, end: 7 });
  });
  it("covered gaps get empty segment arrays; uncovered pages and volatile tail get no record", async () => {
    const h = await opened({ finalizedUntil: 8 });
    h.engine.put("persist", batch([]), { range: { start: 0, end: 3 } });
    h.engine.put("persist", batch([8, 9]));
    await finish(h.persister.flush());
    expect(h.store.records("persist").pages).toHaveLength(1);
    expect(requirePage(h.store.records("persist")).snapshot.segments).toEqual(
      [],
    );
    expectRecords(h.store.records("persist"), h.engine);
    h.engine.clear("persist");
    await finish(h.persister.flush());
    expect(h.store.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
  it("equal states give equal records regardless of put history; fresh buffers do not alias memory", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 1, 3, 4]));
    await finish(h.persister.flush());
    const e = new Engine();
    e.cache(config());
    for (const t of [0, 1, 3, 4]) e.put("persist", batch([t]));
    // Match the authority of the single batch as well as its points.
    e.put("persist", batch([0, 1, 3, 4]));
    expect(h.store.records("persist")).toEqual(recordsOf(e));
    const page = requirePage(h.store.records("persist"));
    page.snapshot.segments[0]?.mask?.fill(0);
    expect(h.engine.get("persist", all).timestamps).toEqual(
      new Float64Array([0, 1, 3, 4]),
    );
  });
});
