import { afterEach, describe, expect, it, vi } from "vitest";
import { CoverageIndex } from "../src/coverage";
import { cacheStateOf, Engine } from "../src/engine/engine";
import { PutError } from "../src/errors";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import type { PutBatch, PutOptions } from "../src/types";
import {
  batch,
  change,
  config,
  id,
  observed,
  view,
} from "./m7-change-test-helpers";
import { recordsOf } from "./persist-test-helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("M7 reader changes: puts (§5.1–2)", () => {
  it("reports the implicit batch span, including confirmed gaps", () => {
    const { engine, events } = observed();
    engine.put(id, batch([3, 23]));
    expect(events).toEqual([change([{ start: 3, end: 23 }])]);
  });

  it.each([
    { range: { start: -6, end: 32 }, written: [{ start: 3, end: 23 }] },
    { range: { start: 13, end: 13 }, written: [{ start: 13, end: 13 }] },
  ])(
    "reports empty-batch authority snapped inward: $range",
    ({ range, written }) => {
      const { engine, events } = observed();
      engine.put(id, batch([]), { range });
      expect(events).toEqual([change(written)]);
    },
  );

  it("reports identical rewrites and flushes separate calls synchronously", () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([13], [7]));
    reset();
    engine.put(id, batch([13], [7]));
    expect(events).toEqual([change([{ start: 13, end: 13 }])]);
    engine.put(id, batch([23], [8]));
    expect(events).toEqual([
      change([{ start: 13, end: 13 }]),
      change([{ start: 23, end: 23 }]),
    ]);
  });

  it.each([false, true])(
    "reports wholly provisional writes with explicit range=%s, without a persistence write",
    (ranged) => {
      const { engine, events, disk } = observed({ finalizedUntil: 13 });
      engine.put(
        id,
        batch([13, 23]),
        ranged ? { range: { start: 13, end: 33 } } : undefined,
      );
      expect(events).toEqual([change([{ start: 13, end: ranged ? 33 : 23 }])]);
      expect(disk).toEqual([]);
      expect(engine.get(id, view).timestamps).toEqual(
        new Float64Array([13, 23]),
      );
    },
  );

  it("combines a first watermark withdrawal and an unclipped write in one report", () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([]), { range: { start: 3, end: 63 } });
    reset();
    engine.put(id, batch([13, 53], [1, 2], { finalizedUntil: 23 }));
    expect(events).toEqual([
      change([{ start: 13, end: 53 }], [{ start: 23, end: 63 }]),
    ]);
  });

  it.each([
    { name: "no meta", initial: {}, meta: undefined },
    {
      name: "own version",
      initial: { version: "v1" },
      meta: { version: "v1" },
    },
    { name: "first adopted version", initial: {}, meta: { version: "v1" } },
    {
      name: "watermark above current",
      initial: { finalizedUntil: 33 },
      meta: { finalizedUntil: 43 },
    },
    {
      name: "watermark at current",
      initial: { finalizedUntil: 33 },
      meta: { finalizedUntil: 33 },
    },
    {
      name: "watermark below current",
      initial: { finalizedUntil: 33 },
      meta: { finalizedUntil: 13 },
    },
  ])(
    "empty put without authority sends nothing: $name",
    ({ initial, meta }) => {
      const { engine, events, reset } = observed(initial);
      engine.put(id, batch([3]));
      reset();
      engine.put(id, batch([], [], meta));
      expect(events).toEqual([]);
      expect(engine.get(id, view).timestamps).toEqual(new Float64Array([3]));
    },
  );

  it("empty put with authority containing no grid slot sends nothing", () => {
    const { engine, events } = observed();
    engine.put(id, batch([]), { range: { start: 4, end: 12 } });
    expect(events).toEqual([]);
  });

  it.each([
    { watermark: -7, removed: [{ start: 3, end: 23 }] },
    { watermark: 3, removed: [{ start: 3, end: 23 }] },
    { watermark: 4, removed: [{ start: 13, end: 23 }] },
    { watermark: 23, removed: [{ start: 23, end: 23 }] },
    { watermark: 24, removed: [] },
  ])(
    "empty put's first watermark $watermark reports only withdrawn coverage",
    ({ watermark, removed }) => {
      const { engine, events, reset } = observed();
      engine.put(id, batch([]), { range: { start: 3, end: 23 } });
      reset();
      engine.put(id, batch([], [], { finalizedUntil: watermark }));
      expect(events).toEqual(removed.length === 0 ? [] : [change([], removed)]);
    },
  );

  const rejected: { name: string; input: PutBatch; options?: PutOptions }[] = [
    { name: "misaligned", input: batch([4]) },
    { name: "unsorted", input: batch([23, 13]) },
    { name: "duplicate", input: batch([13, 13]) },
    { name: "field mismatch", input: { timestamps: [13], fields: {} } },
    { name: "length mismatch", input: batch([13], []) },
    {
      name: "range mismatch",
      input: batch([13]),
      options: { range: { start: 23, end: 33 } },
    },
    { name: "invalid meta", input: batch([13], [1], { version: "" }) },
  ];
  it.each(rejected)(
    "validation reject sends nothing: $name",
    ({ input, options }) => {
      const { engine, events, order, reset } = observed({ version: "v1" });
      engine.put(id, batch([3]));
      reset();
      expect(() =>
        engine.put(
          id,
          { ...input, meta: input.meta ?? { version: "v2" } },
          options,
        ),
      ).toThrow(PutError);
      expect(events).toEqual([]);
      expect(order).toEqual([]);
      expect(engine.get(id, view).timestamps).toEqual(new Float64Array([3]));
    },
  );

  it.each([false, true])(
    "version mismatch emits one clear report after cacheCleared; empty=%s",
    (empty) => {
      const { engine, events, order, reset } = observed({ version: "v1" });
      engine.put(id, batch([3]));
      reset();
      engine.put(
        id,
        batch(empty ? [] : [23], empty ? [] : [9], { version: "v2" }),
      );
      const event = change(empty ? [] : [{ start: 23, end: 23 }], [], true);
      expect(events).toEqual([event]);
      expect(order).toEqual([
        { kind: "cleared", cacheId: id, reason: "version-mismatch" },
        { kind: "changed", event },
      ]);
    },
  );
});

describe("M7 coverage withdrawal and clearing (§5.3–5, §5.9–10)", () => {
  it("invalidating uncovered slots sends nothing, including a repeated invalidation", () => {
    const { engine, events, reset } = observed();
    engine.invalidate(id, { start: 3, end: 23 });
    expect(events).toEqual([]);
    engine.put(id, batch([13]));
    engine.invalidate(id, { start: 13, end: 13 });
    reset();
    engine.invalidate(id, { start: 13, end: 13 });
    expect(events).toEqual([]);
  });

  it("invalidate reports disjoint covered intersections, inclusive ends and outward snapping", () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([3, 23]));
    engine.put(id, batch([53, 63]));
    reset();
    engine.invalidate(id, { start: 22, end: 54 });
    expect(events).toEqual([
      change(
        [],
        [
          { start: 13, end: 23 },
          { start: 53, end: 63 },
        ],
      ),
    ]);
    expect(engine.get(id, view).timestamps).toEqual(
      new Float64Array([3, 23, 53, 63]),
    );
  });

  it("invalidating one covered slot reports precisely that inclusive slot", () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([3, 23]));
    reset();
    engine.invalidate(id, { start: 13, end: 13 });
    expect(events).toEqual([change([], [{ start: 13, end: 13 }])]);
  });

  it.each([
    {
      watermark: -27,
      removed: [
        { start: -17, end: -7 },
        { start: 13, end: 23 },
        { start: 53, end: 63 },
      ],
    },
    {
      watermark: 13,
      removed: [
        { start: 13, end: 23 },
        { start: 53, end: 63 },
      ],
    },
    {
      watermark: 14,
      removed: [
        { start: 23, end: 23 },
        { start: 53, end: 63 },
      ],
    },
    { watermark: 63, removed: [{ start: 63, end: 63 }] },
    { watermark: 64, removed: [] },
  ])(
    "moving watermark back to $watermark reports finite covered ranges in ms",
    ({ watermark, removed }) => {
      const { engine, events, reset } = observed({ finalizedUntil: 83 });
      for (const range of [
        { start: -17, end: -7 },
        { start: 13, end: 23 },
        { start: 53, end: 63 },
      ]) {
        engine.put(id, batch([]), { range });
      }
      reset();
      engine.setFinalizedUntil(id, watermark);
      expect(events).toEqual(removed.length === 0 ? [] : [change([], removed)]);
    },
  );

  it.each([13, 14, 23])(
    "setting the first watermark to %i reports its withdrawn coverage",
    (watermark) => {
      const { engine, events, reset } = observed();
      engine.put(id, batch([3, 23]));
      reset();
      engine.setFinalizedUntil(id, watermark);
      expect(events).toEqual([
        change([], [{ start: watermark === 14 ? 23 : watermark, end: 23 }]),
      ]);
    },
  );

  it("first watermark over an empty cache, a forward move and an unchanged watermark send nothing", () => {
    const { engine, events, reset } = observed();
    engine.setFinalizedUntil(id, 13);
    expect(events).toEqual([]);
    engine.put(id, batch([3, 23]));
    reset();
    engine.setFinalizedUntil(id, 33);
    engine.setFinalizedUntil(id, 33);
    expect(events).toEqual([]);
    expect(engine.coverage(id, view)).toEqual([{ start: 3, end: 3 }]);
  });

  it.each([false, true])(
    "manual clear reports cleared after cacheCleared, initially empty=%s",
    (empty) => {
      const { engine, events, order, reset } = observed();
      if (!empty) engine.put(id, batch([3]));
      reset();
      engine.clear(id);
      const event = change([], [], true);
      expect(events).toEqual([event]);
      expect(order).toEqual([
        { kind: "cleared", cacheId: id, reason: "manual" },
        { kind: "changed", event },
      ]);
    },
  );

  it("clearAll emits once per cache, including an empty one, after each cacheCleared", () => {
    const { engine, events, order, subscribers, reset } = observed();
    engine.cache(config({ id: "second" }));
    subscribers.add("second");
    engine.put(id, batch([3]));
    reset();
    engine.clearAll();
    const first = change([], [], true);
    const second = change([], [], true, "second");
    expect(events).toEqual([first, second]);
    expect(order).toEqual([
      { kind: "cleared", cacheId: id, reason: "clear-all" },
      { kind: "changed", event: first },
      { kind: "cleared", cacheId: "second", reason: "clear-all" },
      { kind: "changed", event: second },
    ]);
  });

  it("without subscribers neither the reader observer nor covered lookup runs for invalidate", () => {
    const { engine, events, subscribers, report, reset } = observed();
    engine.put(id, batch([3, 23]));
    subscribers.clear();
    reset();
    const covered = vi.spyOn(CoverageIndex.prototype, "covered");
    engine.invalidate(id, { start: 13, end: 13 });
    expect(covered).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("subscriber gating is per cache and can turn on and off between mutations", () => {
    const { engine, events, subscribers, reset } = observed();
    engine.cache(config({ id: "quiet" }));
    engine.put("quiet", batch([3]));
    expect(events).toEqual([]);
    engine.put(id, batch([3, 23]));
    reset();
    const covered = vi.spyOn(CoverageIndex.prototype, "covered");
    engine.invalidate(id, { start: 13, end: 13 });
    expect(covered).toHaveBeenCalled();
    expect(events).toEqual([change([], [{ start: 13, end: 13 }])]);
    subscribers.clear();
    reset();
    covered.mockClear();
    engine.invalidate(id, { start: 3, end: 23 });
    expect(covered).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });
});

describe("M7 hydrate, restore and reads (§5.1, §5.7–8)", () => {
  it("hydrate reports all applied parts once, plus first-watermark withdrawals", () => {
    const source = new Engine();
    source.cache(config({ version: "v1", finalizedUntil: 53 }));
    source.put(id, batch([3, 43, 63]));
    const snapshot = source.snapshot(id, view);
    const { engine, events, order, reset } = observed();
    engine.put(id, batch([13, 23]));
    engine.put(id, batch([53, 83]));
    reset();
    const applied = [
      { start: 3, end: 3 },
      { start: 33, end: 43 },
    ];
    expect(engine.hydrate(id, snapshot)).toEqual({ applied });
    const event = change(applied, [{ start: 53, end: 83 }]);
    expect(events).toEqual([event]);
    expect(order).toEqual([{ kind: "changed", event }]);
    expect(engine.get(id, view).timestamps).toEqual(
      new Float64Array([3, 13, 23, 43, 53, 83]),
    );
  });

  it("an idempotent second hydrate sends nothing", () => {
    const source = new Engine();
    source.cache(config());
    source.put(id, batch([3, 23]));
    const snapshot = source.snapshot(id, view);
    const { engine, events, reset } = observed();
    engine.hydrate(id, snapshot);
    reset();
    expect(engine.hydrate(id, snapshot)).toEqual({ applied: [] });
    expect(events).toEqual([]);
  });

  it("a version-mismatch hydrate sends nothing, including no watermark withdrawal", () => {
    const source = new Engine();
    source.cache(config({ version: "old", finalizedUntil: 13 }));
    source.put(id, batch([3]));
    const { engine, events, order, reset } = observed({ version: "new" });
    engine.put(id, batch([3, 23]));
    reset();
    expect(engine.hydrate(id, source.snapshot(id, view))).toEqual({
      applied: [],
      skipped: "version-mismatch",
    });
    expect(events).toEqual([]);
    expect(order).toEqual([]);
    expect(engine.coverage(id, view)).toEqual([{ start: 3, end: 23 }]);
  });

  it("hydrate with only first-version adoption and no applied coverage sends nothing", () => {
    const source = new Engine();
    source.cache(config({ version: "v1" }));
    const { engine, events } = observed();
    expect(engine.hydrate(id, source.snapshot(id, view))).toEqual({
      applied: [],
    });
    expect(events).toEqual([]);
    expect(cacheStateOf(engine, id).version).toBe("v1");
  });

  it("hydrate may withdraw coverage by its first watermark while applying no parts", () => {
    const source = new Engine();
    source.cache(config({ finalizedUntil: 13 }));
    const { engine, events, reset } = observed();
    engine.put(id, batch([3, 23]));
    reset();
    expect(engine.hydrate(id, source.snapshot(id, view))).toEqual({
      applied: [],
    });
    expect(events).toEqual([change([], [{ start: 13, end: 23 }])]);
  });

  it("hydrate whose parts are all volatile sends nothing", () => {
    const source = new Engine();
    source.cache(config());
    source.put(id, batch([3, 23]));
    const { engine, events } = observed({ finalizedUntil: 3 });
    expect(engine.hydrate(id, source.snapshot(id, view))).toEqual({
      applied: [],
    });
    expect(events).toEqual([]);
    expect(engine.get(id, view).timestamps).toEqual(new Float64Array([]));
  });

  it("hydrate that only advances an existing watermark sends nothing", () => {
    const source = new Engine();
    source.cache(config({ finalizedUntil: 53 }));
    const { engine, events } = observed({ finalizedUntil: 33 });
    expect(engine.hydrate(id, source.snapshot(id, view))).toEqual({
      applied: [],
    });
    expect(events).toEqual([]);
    expect(cacheStateOf(engine, id).finalizedUntil).toBe(53);
  });

  it.each([undefined, 53])(
    "restore sends no reader report with creation watermark %s",
    (finalizedUntil) => {
      const source = new Engine();
      source.cache(config({ version: "v1", finalizedUntil: 33 }));
      source.put(id, batch([3, 23]));
      const { engine, events, order } = observed(
        finalizedUntil === undefined ? {} : { finalizedUntil },
      );
      expect(
        cacheStateOf(engine, id).restore(recordsOf(source, id)).applied,
      ).toEqual([{ start: 3, end: 23 }]);
      expect(events).toEqual([]);
      expect(order).toEqual([]);
      expect(engine.get(id, view).timestamps).toEqual(
        new Float64Array([3, 23]),
      );
    },
  );

  it("get, snapshot, coverage and validation rejects send no reader report", () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([3]));
    reset();
    engine.get(id, view);
    engine.get(id, view, { snapshot: true });
    engine.snapshot(id, view);
    engine.coverage(id, view);
    expect(() => engine.hydrate(id, {} as never)).toThrow();
    expect(() => engine.invalidate(id, { start: 23, end: 3 })).toThrow();
    expect(() => engine.setFinalizedUntil(id, Number.NaN)).toThrow();
    expect(events).toEqual([]);
  });

  it("cacheOnly get, no-fetcher get and updateAuth send nothing", async () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([3]));
    reset();
    const orchestrator = new Orchestrator(engine, () => {});
    await orchestrator.get(id, view, { cacheOnly: true });
    await orchestrator.get(id, view);
    await orchestrator.updateAuth({ user: "reader" });
    expect(events).toEqual([]);
  });

  it.each(["failure", "auth"])(
    "a fetch ending in %s and a subsequent cacheOnly read send nothing",
    async (mode) => {
      const { engine, events } = observed();
      const orchestrator = new Orchestrator(engine, () => {});
      const code =
        mode === "auth" ? 'error.code = "tscache:auth-invalid";' : "";
      await orchestrator.load({
        module: `data:text/javascript,${encodeURIComponent(`export default { async fetch() { const error = new Error("rejected"); ${code} throw error; } };`)}`,
      });
      const result = await orchestrator.get(id, view);
      expect(result.misses.map((miss) => miss.reason)).toEqual([
        mode === "auth" ? "auth-pending" : "fetch-failed",
      ]);
      if (mode === "auth") {
        // Auth is invalid now: the next fetching read is not issued.
        expect((await orchestrator.get(id, view)).misses[0]?.reason).toBe(
          "auth-pending",
        );
      }
      await orchestrator.get(id, view, { cacheOnly: true });
      expect(events).toEqual([]);
    },
  );

  it("an applied fetch reports its put authority once to the internal observer", async () => {
    const { engine, events } = observed();
    const orchestrator = new Orchestrator(engine, () => {});
    await orchestrator.load({
      module: `data:text/javascript,${encodeURIComponent("export default { async fetch() { return { timestamps: [13], fields: { value: [9] } }; } };")}`,
    });
    const result = await orchestrator.get(id, { start: 3, end: 23 });
    expect(result.timestamps).toEqual(new Float64Array([13]));
    expect(events).toEqual([change([{ start: 3, end: 23 }])]);
  });

  it("a version-fenced fetch sends nothing after its response is released", async () => {
    let started: () => void = () => {};
    let release: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("__m7ChangeFetch", { started, gate });
    const { engine, events, reset } = observed();
    const orchestrator = new Orchestrator(engine, () => {});
    await orchestrator.load({
      module: `data:text/javascript,${encodeURIComponent("export default { async fetch() { const control = globalThis.__m7ChangeFetch; control.started(); await control.gate; return { timestamps: [13], fields: { value: [9] } }; } };")}`,
    });
    const pending = orchestrator.get(id, view);
    await entered;
    // This clear fences the response. Fill the missing range as a confirmed
    // gap so N29's second round needs no fetch; isolate the dropped response.
    engine.clear(id);
    engine.put(id, batch([]), { range: view });
    reset();
    release();
    const result = await pending;
    expect(result.timestamps).toEqual(new Float64Array([]));
    expect(result.coverage).toEqual([view]);
    expect(events).toEqual([]);
  });
});
