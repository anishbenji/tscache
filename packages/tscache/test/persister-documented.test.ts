// Regression tests for behaviour that step 132 wrote into architecture
// §4.10.5–§4.10.6 from the code as it stood. They pin current, documented
// behaviour rather than a change, so they are implementer tests, not
// contract tests (docs/reviews/step-132.md).
import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { Persister } from "../src/persist/persister";
import { fakeTime, harness, tick, writes } from "./persist-harness";
import {
  all,
  batch,
  config,
  fixture,
  requireCache,
  state,
  tracked,
} from "./persist-test-helpers";

fakeTime();
describe("step 132: documented persister behaviour (§4.10.5–§4.10.6)", () => {
  it("flush(id) with nothing dirty waits for the cache's running flush job", async () => {
    const h = harness();
    h.engine.cache(config());
    await h.persister.open("persist");
    h.engine.put("persist", batch([0, 1]));
    const gate = h.store.gate("write");
    void h.persister.flush("persist");
    await tick();
    await gate.entered;
    const second = tracked(h.persister.flush("persist"));
    await tick();
    expect(second.done).toBe(false);
    gate.release();
    await second.promise;
    expect(writes(h.store)).toHaveLength(1);
  });
  it("a repeated close() resolves when the first one does", async () => {
    const h = harness();
    h.engine.cache(config());
    await h.persister.open("persist");
    h.engine.put("persist", batch([0, 1]));
    const gate = h.store.gate("write");
    const first = tracked(h.persister.close());
    await tick();
    await gate.entered;
    const second = tracked(h.persister.close());
    await tick();
    expect(second.done).toBe(false);
    gate.release();
    await second.promise;
    expect(first.done).toBe(true);
  });
  it("a failed store opening stops a running cache too, without a cleanup", async () => {
    const engine = new Engine();
    engine.cache(config());
    const stopped: unknown[] = [];
    let opens = 0;
    const p = new Persister(
      engine,
      async () => {
        opens++;
        // The clear finds no database; the flush's opening then fails.
        if (opens === 1) return undefined;
        throw Object.assign(new Error("denied"), { name: "SecurityError" });
      },
      { onStopped: (event: unknown) => stopped.push(event) },
    );
    engine.clearAll();
    const cleared = p.clearAll();
    // Opened during the barrier: running at once, with no load.
    await p.open("persist");
    await tick();
    await cleared;
    engine.put("persist", batch([0, 1]));
    await tick(1000);
    expect(opens).toBe(2);
    // The opening's own stop, before any job's deadline.
    expect(stopped).toEqual([
      {
        cacheId: "persist",
        reason: "unavailable",
        error: { name: "SecurityError", message: "denied" },
      },
    ]);
  });
  it("restore rejects a cache record whose cacheId is another cache's", () => {
    const records = fixture();
    requireCache(records).cacheId = "foreign";
    const target = state();
    expect(target.restore(records)).toEqual({ applied: [], rewrite: true });
    expect(target.coverage(all)).toEqual([]);
  });
});
