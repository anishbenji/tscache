import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReaderChange } from "../src/engine/cache";
import {
  cacheGridOf,
  engineMemoryInternals,
  observeCaches,
} from "../src/engine/engine";
import { toMs } from "../src/grid";
import { RpcServer } from "../src/rpc/server";
import type { ClientEvents, Range } from "../src/types";
import {
  batch,
  config,
  fetching,
  MemoryEngine,
  PAGE_BYTES,
  send,
  span,
  type Wire,
  whole,
  wire,
} from "./m3-memory-helpers";

type Report = ReaderChange & { evicted?: Range[] };
type Changed = ClientEvents["cacheChanged"] & { evicted?: Range[] };
const connections: Wire[] = [];
afterEach(() => {
  for (const w of connections.splice(0)) w.close();
  vi.restoreAllMocks();
});

function observed(readers = true) {
  const engine = new MemoryEngine({ memoryBudget: PAGE_BYTES });
  const reports: {
    cacheId: string;
    written: Range[];
    removed: Range[];
    cleared: boolean;
    evicted?: Range[];
  }[] = [];
  const report = vi.fn((cacheId: string, change: Report) => {
    const grid = cacheGridOf(engine, cacheId);
    reports.push({
      cacheId,
      written: change.written.map((r) => toMs(r, grid)),
      removed: change.removed.map((r) => toMs(r, grid)),
      cleared: change.cleared,
      ...(change.evicted === undefined
        ? {}
        : { evicted: change.evicted.map((r) => toMs(r, grid)) }),
    });
  });
  const subscribers = new Set(readers ? ["a", "b", "r"] : []);
  observeCaches(engine, {
    onChange: () => {},
    onMutate: () => {},
    hasReaders: (id) => subscribers.has(id),
    onReaderChange: report,
  });
  engine.cache(config({ version: "v1", finalizedUntil: 100 }));
  engine.cache(config({ id: "b" }));
  return {
    engine,
    reports,
    report,
    subscribers,
    reset: () => {
      reports.length = 0;
      report.mockClear();
    },
  };
}
function evictedPage() {
  const h = observed();
  h.engine.put("a", batch([0]), { range: span(0, 3) });
  h.engine.put("b", batch([4]));
  expect(h.engine.coverage("a", span(0, 3))).toEqual([]);
  expect(h.engine.get("a", span(0, 3)).timestamps).toHaveLength(0);
  h.reset();
  return h;
}
function changes(w: Wire): Changed[] {
  return w.events.flatMap((e) =>
    e.event === "cacheChanged" ? [e.payload as Changed] : [],
  );
}

describe("M3 and M7 (design §5 tests 18–19)", () => {
  it("18: one put reports written plus own eviction, and another cache's eviction, once each with its requestId", async () => {
    const engine = new MemoryEngine({ memoryBudget: 2 * PAGE_BYTES });
    const server = new RpcServer(engine, "test");
    const a = await wire(server);
    const b = await wire(server);
    connections.push(a, b);
    await a.client.request("cache", config());
    await a.client.request("cache", config({ id: "b" }));
    await a.client.request("put", {
      cacheId: "a",
      batch: batch([0]),
      options: { range: span(0, 3) },
    });
    await a.client.request("put", {
      cacheId: "b",
      batch: batch([16]),
      options: { range: span(16, 18) },
    });
    await a.client.request("subscribe", { all: true });
    await a.client.request("subscribe", { cacheId: "a" });
    await b.client.request("subscribe", { all: true });
    a.events.length = 0;
    b.events.length = 0;
    const sent = send(a, "put", { cacheId: "a", batch: batch([4, 8]) });
    await sent.answer;
    // Ordered response on b makes the cross-port absence/count exact.
    await b.client.request("cache", config());
    const expected = [
      {
        cacheId: "a",
        written: [span(4, 8)],
        removed: [],
        cleared: false,
        evicted: [span(0, 3)],
        requestId: sent.requestId,
      },
      {
        cacheId: "b",
        written: [],
        removed: [],
        cleared: false,
        evicted: [span(16, 18)],
        requestId: sent.requestId,
      },
    ];
    // The spec does not impose an order between different caches' reports.
    expect(
      changes(a).sort((x, y) => x.cacheId.localeCompare(y.cacheId)),
    ).toEqual(expected);
    expect(
      changes(b).sort((x, y) => x.cacheId.localeCompare(y.cacheId)),
    ).toEqual(expected);
  });

  it("18: enforcement at pin release groups evictions under that get's requestId", async () => {
    const engine = new MemoryEngine({ memoryBudget: PAGE_BYTES });
    const server = new RpcServer(engine, "test");
    fetching();
    const w = await wire(server, true);
    connections.push(w);
    await w.client.request("cache", config());
    await w.client.request("subscribe", { cacheId: "a" });
    const sent = send(w, "get", { cacheId: "a", range: span(0, 11) });
    await sent.answer;
    const events = changes(w);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      cacheId: "a",
      written: [span(0, 11)],
      removed: [],
      cleared: false,
      requestId: sent.requestId,
    });
    expect(events[1]).toEqual({
      cacheId: "a",
      written: [],
      removed: [],
      cleared: false,
      evicted: [span(0, 7)],
      requestId: sent.requestId,
    });
    expect(engine.memoryStats()).toMatchObject({
      bytes: PAGE_BYTES,
      pinnedBytes: 0,
    });
  });

  it("18: evicted reports contain only withdrawn coverage in ms, with holes and negative pages preserved", () => {
    const h = observed();
    h.engine.cache(config({ id: "offset", interval: 10, alignmentOffset: 3 }));
    h.subscribers.add("offset");
    h.engine.put("offset", batch([-37, -17])); // Page -1 covers -37..-17.
    h.engine.invalidate("offset", span(-27));
    h.reset();
    h.engine.put("b", batch([4]));
    expect(h.reports.filter((r) => r.cacheId === "offset")).toEqual([
      {
        cacheId: "offset",
        written: [],
        removed: [],
        cleared: false,
        evicted: [span(-37), span(-17)],
      },
    ]);
  });

  it("18: evicting points with no coverage emits no event for their cache", () => {
    const h = observed();
    h.engine.put("a", batch([0]));
    h.engine.invalidate("a", span(0));
    h.reset();
    h.engine.put("b", batch([4]));
    expect(h.reports.map((r) => r.cacheId)).toEqual(["b"]);
    expect(h.engine.memoryStats().evictedPages).toBe(1);
  });

  it("18/A3: no subscriber means no reader report or wire event; evicted coverage is still remembered", async () => {
    const h = observed(false);
    const server = new RpcServer(h.engine, "test");
    const w = await wire(server);
    connections.push(w);
    await w.client.request("put", {
      cacheId: "a",
      batch: batch([0]),
      options: { range: span(0, 3) },
    });
    await w.client.request("put", { cacheId: "b", batch: batch([4]) });
    expect(h.report).not.toHaveBeenCalled();
    expect(changes(w)).toEqual([]);
    expect(engineMemoryInternals(h.engine).evictedIndex("a")?.ranges()).toEqual(
      [span(0, 3)],
    );
    await w.client.request("subscribe", { cacheId: "a" });
    const sent = send(w, "invalidate", { cacheId: "a", range: span(1, 2) });
    await sent.answer;
    expect(changes(w)).toHaveLength(1);
    expect(changes(w)).toMatchObject([
      {
        cacheId: "a",
        written: [],
        removed: [span(1, 2)],
        cleared: false,
        requestId: sent.requestId,
      },
    ]);
    expect(changes(w)[0]?.evicted ?? []).toEqual([]);
  });

  it("18: reads, unchanged calls, validation rejects and forward watermarks produce no reader event", () => {
    const h = observed();
    h.engine.put("a", batch([0]));
    const snapshot = h.engine.snapshot("a", span(0));
    h.reset();
    h.engine.get("a", whole);
    h.engine.get("a", whole, { snapshot: true });
    h.engine.snapshot("a", whole);
    h.engine.coverage("a", whole);
    h.engine.put("a", batch([]));
    h.engine.hydrate("a", snapshot);
    h.engine.hydrate("a", { ...snapshot, version: "v2" });
    h.engine.setFinalizedUntil("a", 101);
    expect(() => h.engine.put("a", batch([1, 0]))).toThrow();
    expect(h.reports).toEqual([]);
  });

  it("19: invalidate clips remembered coverage, consumes it once, and never reports unknown slots", () => {
    const h = evictedPage();
    h.engine.invalidate("a", span(1, 2));
    expect(h.reports).toMatchObject([
      { cacheId: "a", written: [], removed: [span(1, 2)], cleared: false },
    ]);
    h.reset();
    h.engine.invalidate("a", span(1, 2));
    expect(h.reports).toEqual([]);
    h.engine.invalidate("a", span(-4, 7));
    expect(h.reports).toMatchObject([
      {
        cacheId: "a",
        written: [],
        removed: [span(0), span(3)],
        cleared: false,
      },
    ]);
  });

  it("19: a write forgets only its touched part of the evicted index", () => {
    const h = evictedPage();
    h.engine.put("a", batch([1], [9]));
    // Consume slot 1's new coverage: withdrawing it again must not
    // resurrect the old evicted history that the write replaced.
    h.engine.invalidate("a", span(1));
    h.reset();
    h.engine.invalidate("a", span(0, 3));
    expect(h.reports).toMatchObject([
      {
        cacheId: "a",
        written: [],
        removed: [span(0), span(2, 3)],
        cleared: false,
      },
    ]);
    h.reset();
    h.engine.invalidate("a", span(0, 3));
    expect(h.reports).toEqual([]);
  });

  it.each(["back", "first"])(
    "19: a %s watermark reports remembered coverage once",
    (mode) => {
      const h = mode === "back" ? evictedPage() : observed();
      if (mode === "first") {
        h.engine.cache(config({ id: "r" }));
        h.engine.put("r", batch([0]), { range: span(0, 3) });
        h.engine.put("b", batch([4]));
        expect(h.engine.coverage("r", span(0, 3))).toEqual([]);
        expect(h.engine.get("r", span(0, 3)).timestamps).toHaveLength(0);
        h.reset();
      }
      const id = mode === "back" ? "a" : "r";
      h.engine.setFinalizedUntil(id, 2);
      expect(h.reports).toMatchObject([
        { cacheId: id, written: [], removed: [span(2, 3)], cleared: false },
      ]);
      h.reset();
      h.engine.setFinalizedUntil(id, 2);
      expect(h.reports).toEqual([]);
      h.engine.setFinalizedUntil(id, 0);
      expect(h.reports).toMatchObject([{ cacheId: id, removed: [span(0, 1)] }]);
    },
  );

  it.each(["clear", "clearAll", "version mismatch"])(
    "19: %s empties remembered evictions",
    (operation) => {
      const h = evictedPage();
      if (operation === "clear") h.engine.clear("a");
      else if (operation === "clearAll") h.engine.clearAll();
      else h.engine.put("a", batch([], [], { version: "v2" }));
      h.reset();
      h.engine.invalidate("a", span(0, 3));
      expect(h.reports).toEqual([]);
    },
  );

  it("19: hydrate forgets its applied part but keeps the rest of evicted coverage", () => {
    const h = evictedPage();
    const donor = new MemoryEngine();
    donor.cache(config({ version: "v1" }));
    donor.put("a", batch([1, 2]));
    h.engine.hydrate("a", donor.snapshot("a", span(1, 2)));
    h.engine.invalidate("a", span(1, 2));
    h.reset();
    h.engine.invalidate("a", span(0, 3));
    expect(h.reports).toMatchObject([
      { cacheId: "a", removed: [span(0), span(3)] },
    ]);
  });
});
