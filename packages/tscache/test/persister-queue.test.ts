import { describe, expect, it, vi } from "vitest";
import {
  fakeTime,
  finish,
  harness,
  opened,
  tick,
  writes,
} from "./persist-harness";
import { batch, config, tracked } from "./persist-test-helpers";

// Implementer tests (§4.10.6): which queued job the store sees first, a
// failed flush that meets a queued one, and what close() leaves behind.
// Time is Vitest's fake clock; the store is the MemoryStore seam.
fakeTime();

async function three() {
  const h = harness();
  for (const id of ["a", "b", "c"]) {
    h.engine.cache(config({ id }));
    await h.persister.open(id);
  }
  return h;
}

describe("job order (§4.10.6)", () => {
  it("of two due jobs the one due earlier runs first, though it was queued later", async () => {
    const h = await three();
    const gate = h.store.gate("write");
    h.engine.put("a", batch([0]));
    await tick(100);
    h.engine.put("b", batch([0])); // b's job is created first...
    await tick(100);
    h.engine.put("c", batch([0])); // ...c's second, due at 1200 ms
    await tick(100);
    h.engine.put("b", batch([1])); // and b's quiet spell now ends at 1300 ms
    await tick(700);
    await gate.entered; // a's write, at 1000 ms, holds the store
    await tick(1000);
    gate.release();
    await finish(h.persister.flush());
    expect(writes(h.store).map((w) => w.cacheId)).toEqual(["a", "c", "b"]);
  });
});

describe("a failed flush while its cache has a queued job (§4.10.6)", () => {
  it("joins the queued job: its flush() callers settle with it and the retry stays due", async () => {
    const h = await opened();
    const gate = h.store.gate("write");
    h.engine.put("persist", batch([0]));
    const flushed = tracked(h.persister.flush());
    await tick();
    await gate.entered;
    // A change while the write is out queues a second job.
    h.engine.put("persist", batch([1]));
    gate.reject(Object.assign(new Error("planted"), { name: "UnknownError" }));
    await tick();
    expect(flushed.done).toBe(false);
    // Keep the cache changing, so only the retry (1000 ms) makes it due.
    for (let i = 0; i < 4; i++) {
      await tick(250);
      h.engine.put("persist", batch([2 + i]));
    }
    expect(writes(h.store)).toHaveLength(2);
    expect(flushed.done).toBe(true);
  });
});

describe("close (§4.10.6)", () => {
  it("leaves no timer armed and later work unwritten", async () => {
    const h = await opened();
    h.engine.put("persist", batch([0]));
    await finish(h.persister.close());
    expect(writes(h.store)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    const calls = h.store.log.length;
    h.engine.put("persist", batch([1]));
    // Settles at once: nothing is queued after close.
    const flushed = tracked(h.persister.flush());
    await tick();
    expect(flushed.done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await tick(10_000);
    expect(h.store.log).toHaveLength(calls);
  });

  it("settles for a persister that never opened its store", async () => {
    const h = harness();
    await finish(h.persister.close());
    expect(h.openStore).not.toHaveBeenCalled();
  });
});
