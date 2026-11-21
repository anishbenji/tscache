// Implementer tests for HostedPersistence.supersede() beside a second open of
// the same cache (docs/architecture.md §4.10.8, Lazy loading; N59, N110):
// a cache is reported once, whenever its opens and the chunk arrive. The
// contract tests are in persist-deploy-skew.test.ts (test 7).

import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { HostedPersistence } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import type { ClientEvents } from "../src/types";
import { fakeTime, tick } from "./persist-harness";
import { deferred, MemoryStore } from "./persist-memory-store";
import { config, fixture, tracked } from "./persist-test-helpers";

fakeTime();

const timeoutMs = 25;

function hosted() {
  const store = new MemoryStore();
  store.seed("persist", fixture());
  const engine = new Engine();
  engine.cache(config());
  const chunk = deferred<typeof lazy>();
  const load = vi.fn(() => chunk.promise);
  const stops: ClientEvents["persistStopped"][] = [];
  const persistence = new HostedPersistence(engine, load, async () => store, {
    timeoutMs,
    onStopped: (event) => stops.push(event),
  });
  return { store, chunk, load, stops, persistence };
}

const superseded = [{ cacheId: "persist", reason: "superseded" }];

describe("a cache opened again between supersede() and the chunk", () => {
  it.each(["arrives", "fails", "times out"])(
    "is reported once when the chunk %s",
    async (outcome) => {
      const h = hosted();
      const first = tracked(h.persistence.open("persist"));
      h.persistence.supersede();
      // The same cache again, as a second tab's cache() asks for it.
      const second = tracked(h.persistence.open("persist"));
      await tick();
      // Both wait for the chunk: the open that stops is the one waiting.
      expect([first.done, second.done]).toEqual([false, false]);
      expect(h.stops).toEqual([]);

      if (outcome === "arrives") h.chunk.resolve(lazy);
      else if (outcome === "fails") h.chunk.reject(new Error("no chunk"));
      else await tick(timeoutMs);
      await tick();
      await Promise.all([first.promise, second.promise]);
      expect(h.stops).toEqual(superseded);

      // And once for good, whoever asks again.
      await h.persistence.open("persist");
      await tick();
      expect(h.stops).toEqual(superseded);
      expect(h.load).toHaveBeenCalledTimes(1);
      expect(h.store.log).toEqual([]);
    },
  );

  it("a second open without supersede() joins the first as well", async () => {
    const h = hosted();
    const first = h.persistence.open("persist");
    const second = h.persistence.open("persist");
    h.chunk.resolve(lazy);
    await tick();
    await Promise.all([first, second]);
    expect(h.stops).toEqual([]);
    expect(h.store.log.map(({ kind }) => kind)).toEqual(["read"]);
  });
});
