import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { Persister } from "../src/persist/persister";
import { DenseSegment } from "../src/segment/dense";
import {
  clearAll,
  fakeTime,
  finish,
  opened,
  tick,
  writes,
} from "./persist-harness";
import { deferred, MemoryStore } from "./persist-memory-store";
import {
  all,
  batch,
  config,
  expectRecords,
  tracked,
} from "./persist-test-helpers";

// Implementer tests (review round 9, R9-1; architecture §4.10.6, Flush): a
// flush attempt takes its dirty state and builds its plan in the step that
// starts it, before it awaits anything. A change made later, during a
// clearAll barrier in particular, is never consumed by that attempt.

fakeTime();
describe("a flush attempt takes its state before its first await (round 9, R9-1)", () => {
  it("a flush waiting for the store's opening writes the state it took at its start, never a change made during a later barrier", async () => {
    const engine = new Engine();
    const store = new MemoryStore();
    const opening = deferred<MemoryStore>();
    const p = new Persister(engine, (o?: { ifExists?: boolean }) =>
      o?.ifExists === true ? Promise.resolve(undefined) : opening.promise,
    );
    // The first clearAll finds no database; the cache, opened during its
    // barrier, starts cold.
    const first = p.clearAll();
    engine.cache(config());
    await p.open("persist");
    await finish(first);
    engine.put("persist", batch([4]));
    void p.flush("persist");
    await tick();
    // The attempt took slot 4 and waits for the opening; slot 0 is put
    // during the barrier of a clearAll called meanwhile.
    const second = clearAll({ engine, persister: p });
    engine.put("persist", batch([0]));
    opening.resolve(store);
    await finish(second);
    await finish(p.flush());
    expect(store.log.map((c) => c.kind)).toEqual([
      "write",
      "clearAll",
      "write",
    ]);
    const final = writes(store)[0]?.plan;
    expect(final?.putPages.map((page) => page.page)).toEqual([1]);
    expectRecords(store.records("persist"), engine);
    expect(engine.coverage("persist", all)).toEqual([{ start: 0, end: 0 }]);
  });

  it("with the store open, a clearAll in the microtasks after the attempt started cannot reach its state", async () => {
    const h = await opened();
    h.engine.cache(config({ id: "Y" }));
    await h.persister.open("Y");
    h.engine.put("persist", batch([0, 1]));
    await finish(h.persister.flush());
    h.engine.invalidate("persist", { start: 1, end: 1 });
    h.engine.put("Y", batch([0]));
    void h.persister.flush("Y");
    let second: Promise<void> | undefined;
    // durable() resolves as the removal's write lands, just before Y's flush
    // starts in the same step; its continuation runs in the microtasks after.
    const answered = h.persister.durable("persist").then(() => {
      second = clearAll(h);
      h.engine.put("Y", batch([5]));
    });
    await tick();
    await answered;
    await finish(second as Promise<void>);
    await finish(h.persister.flush());
    expectRecords(h.store.records("Y"), h.engine, "Y");
    expect(h.engine.coverage("Y", all)).toEqual([{ start: 5, end: 5 }]);
  });

  it("a plan that cannot be built is a rejected attempt: its state goes back and the retry writes it", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0, 5]));
    vi.spyOn(DenseSegment.prototype, "transferPayload").mockImplementationOnce(
      () => {
        throw new RangeError("planted allocation failure");
      },
    );
    const flushed = tracked(h.persister.flush("persist"));
    await tick();
    expect(writes(h.store)).toEqual([]);
    expect(flushed.done).toBe(false);
    await tick(1000);
    await flushed.promise;
    expect(writes(h.store)).toHaveLength(1);
    expectRecords(h.store.records("persist"), h.engine);
    expect(h.stopped).toEqual([]);
  });
});
