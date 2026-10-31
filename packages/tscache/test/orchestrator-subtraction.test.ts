import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidRangeError } from "../src/errors";
import type { FetchRequest, FetchResponse } from "../src/types";
import {
  authError,
  complete,
  config,
  Harness,
  miss,
  range as r,
} from "./orchestrator-subtraction-helpers";

// Contract tests from docs/reviews/step-44.md. Gates and ordered port round
// trips determine every interleaving; there are no wall-clock sleeps.
const active: Harness[] = [];
function harness(extra: ConstructorParameters<typeof Harness>[0] = {}) {
  const h = new Harness(extra);
  active.push(h);
  return h;
}
afterEach(async () => {
  for (const h of active.splice(0)) await h.close();
  vi.restoreAllMocks();
});

async function overlap(h: Harness) {
  const a = await h.connect();
  const b = await h.connect();
  const x = h.get(a, r(3, 103));
  await h.turn(a);
  const y = h.get(b, r(53, 153));
  await h.turn(b);
  expect(h.ranges()).toEqual([r(3, 103), r(113, 153)]);
  return { a, b, x, y };
}

async function version(
  h: Harness,
  client: Awaited<ReturnType<Harness["connect"]>>,
  v: string,
) {
  await h.put(client, r(503, 503), v);
}

function uniqueUncovered(
  ranges: ReturnType<Harness["ranges"]>,
  wanted: ReturnType<typeof r>,
  covered: number[] = [],
) {
  for (let t = wanted.start; t <= wanted.end; t += 10) {
    if (!covered.includes(t))
      expect(
        ranges.filter((range) => range.start <= t && t <= range.end),
        `slot ${t}`,
      ).toHaveLength(1);
  }
}

describe("N31 in-flight subtraction", () => {
  it.each(["request order", "reverse order"])(
    "T7: partial overlap across clients waits for both fetches (%s)",
    async (order) => {
      const h = harness();
      const { a, b, x, y } = await overlap(h);
      const first = order === "request order" ? 0 : 1;
      h.call(first).answer();
      await h.turn(b);
      await h.turn(a);
      expect(y.settled()).toBe(false);
      h.call(1 - first).answer();
      complete(await x.promise, r(3, 103));
      complete(await y.promise, r(53, 153));
      expect(h.calls).toHaveLength(2);
    },
  );

  it("T8: a contained read joins without issuing a request and returns the issuer's values", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const y = h.get(b, r(33, 73));
    await h.turn(b);
    expect(h.ranges()).toEqual([r(3, 103)]);
    expect(y.settled()).toBe(false);
    h.call(0).answer();
    await x.promise;
    const got = await y.promise;
    complete(got, r(33, 73));
    expect(Array.from(got.fields.volume ?? [])).toEqual([1, 1, 1, 1, 1]);
  });

  it("T9: identical ranges still share one fetch (companion to the unchanged N31 regression)", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const y = h.get(b, r(3, 103));
    await h.turn(b);
    expect(h.calls).toHaveLength(1);
    expect(y.settled()).toBe(false);
    h.call(0).answer();
    complete(await x.promise, r(3, 103));
    complete(await y.promise, r(3, 103));
  });

  it("T10: fetches only the gap between two outstanding fetches and awaits all three", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const c = await h.connect();
    const x = h.get(a, r(3, 43));
    await h.turn(a);
    const z = h.get(c, r(103, 143));
    await h.turn(c);
    const y = h.get(b, r(3, 143));
    await h.turn(b);
    expect(h.ranges()).toEqual([r(3, 43), r(103, 143), r(53, 93)]);
    h.call(2).answer();
    await h.turn(b);
    expect(y.settled()).toBe(false);
    h.call(0).answer();
    await x.promise;
    await h.turn(b);
    expect(y.settled()).toBe(false);
    h.call(1).answer();
    await z.promise;
    complete(await y.promise, r(3, 143));
  });

  it.each([false, true])(
    "T11: adds a flank into coverage only (covered=%s)",
    async (covered) => {
      const h = harness();
      const a = await h.connect();
      const b = await h.connect();
      const x = covered ? undefined : h.get(a, r(3, 103));
      if (covered) await h.put(a, r(3, 103));
      else await h.turn(a);
      const y = h.get(b, r(113, 153));
      await h.turn(b);
      expect(h.ranges()).toEqual(
        covered ? [r(103, 153)] : [r(3, 103), r(113, 153)],
      );
      for (const call of h.calls) call.answer();
      await x?.promise;
      complete(await y.promise, r(113, 153));
    },
  );

  it("T12: does not await an in-flight overlap that is already covered", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    await h.put(a, r(3, 103));
    const x = h.get(a, r(113, 153));
    await h.turn(a);
    expect(h.ranges()).toEqual([r(103, 153)]);
    const y = h.get(b, r(53, 103));
    await h.turn(b);
    expect(y.settled()).toBe(true);
    expect(x.settled()).toBe(false);
    complete(await y.promise, r(53, 103));
    expect(h.calls).toHaveLength(1);
    h.call(0).answer();
    await x.promise;
  });

  it("T13: a get in the first reaction to a failed get starts a fresh fetch", async () => {
    const h = harness();
    const o = await h.direct();
    const x = o.get(config.id, r(3, 43));
    const y = x.then(() => o.get(config.id, r(3, 43)));
    h.call(0).fail(new Error("E"));
    expect((await x).misses).toEqual([miss(3, 43, "fetch-failed", "E")]);
    expect(h.ranges()).toEqual([r(3, 43), r(3, 43)]);
    h.call(1).answer();
    complete(await y, r(3, 43));
  });

  it.each(["rejection", "invalid response"])(
    "T14: shared failure labels only missing overlap and the next get retries (%s)",
    async (failure) => {
      const h = harness();
      const { a, b, x, y } = await overlap(h);
      if (failure === "rejection") h.call(0).fail(new Error("E"));
      else
        h.call(0).respond({
          timestamps: [4],
          fields: { price: [4], volume: [1] },
        });
      h.call(1).answer();
      const failed = await x.promise;
      const error = failed.misses[0]?.error;
      if (failure === "rejection")
        expect(error).toEqual({ name: "Error", message: "E" });
      // A miss carries the error's name and message only (§4.9): the class
      // is documented, the message text is not, and PutError's code
      // (§2.6) does not travel on a miss.
      else
        expect(error).toEqual({
          name: "PutError",
          message: expect.any(String),
        });
      expect(failed.misses).toEqual([
        { range: r(3, 103), reason: "fetch-failed", error },
      ]);
      const got = await y.promise;
      expect(got.misses).toEqual([
        { range: r(53, 103), reason: "fetch-failed", error },
      ]);
      expect(Array.from(got.timestamps)).toEqual([113, 123, 133, 143, 153]);
      const retry = h.get(a, r(53, 103));
      await h.turn(b);
      await h.turn(a);
      expect(h.ranges().at(-1)).toEqual(r(53, 113));
      h.call(2).answer();
      complete(await retry.promise, r(53, 103));
    },
  );

  it.each(["a first", "b first"])(
    "T15: every first-round waiter shares refetches after an external version clear (%s)",
    async (order) => {
      const h = harness();
      const seed = await h.connect();
      await version(h, seed, "v1");
      const { a, b, x, y } = await overlap(h);
      await version(h, seed, "v2");
      const first = order === "a first" ? 0 : 1;
      h.call(first).answer("v1");
      await h.turn(a);
      await h.turn(b);
      h.call(1 - first).answer("v1");
      await h.turn(a);
      await h.turn(b);
      const retry = h.ranges().slice(2);
      uniqueUncovered(retry, r(3, 153));
      expect(retry).toHaveLength(2);
      for (const call of h.calls.slice(2)) call.answer("v2");
      complete(await x.promise, r(3, 103));
      complete(await y.promise, r(53, 153));
      expect(h.calls).toHaveLength(4);
    },
  );

  it("T16: the awaited clearing fetch applies, while a dropped fetch triggers shared refetches", async () => {
    const h = harness();
    const seed = await h.connect();
    await version(h, seed, "v1");
    const { a, b, x, y } = await overlap(h);
    h.call(1).answer("v2");
    await h.turn(b);
    h.call(0).answer("v1");
    await h.turn(a);
    await h.turn(b);
    const retry = h.ranges().slice(2);
    uniqueUncovered(retry, r(3, 103));
    expect(retry.every((q) => q.end <= 113)).toBe(true);
    expect(retry.some((q) => q.end === 113)).toBe(true);
    expect(retry).toEqual(
      retry.length === 1 ? [r(3, 113)] : [r(53, 113), r(3, 43)],
    );
    for (const call of h.calls.slice(2)) call.answer("v2");
    complete(await x.promise, r(3, 103));
    complete(await y.promise, r(53, 153));
  });

  it("T17: a post-clear get never joins the pre-clear fetch (replacement setup, old regression retained)", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    await version(h, a, "v1");
    const x = h.get(a, r(3, 73));
    await h.turn(a);
    await version(h, b, "v2");
    const y = h.get(b, r(3, 73));
    await h.turn(b);
    expect(h.ranges()).toEqual([r(3, 73), r(3, 73)]);
    h.call(1).answer("v2");
    complete(await y.promise, r(3, 73));
    expect(x.settled()).toBe(false);
    h.call(0).answer("v1");
    complete(await x.promise, r(3, 73));
    expect(h.calls).toHaveLength(2);
  });

  it("T18: applied-then-wiped overlap re-plans once and completes (N29 as amended, DC-1 option b)", async () => {
    const h = harness();
    const seed = await h.connect();
    await version(h, seed, "v1");
    const { b, x, y } = await overlap(h);
    h.call(0).answer("v1");
    complete(await x.promise, r(3, 103));
    h.call(1).answer("v2");
    await h.turn(b);
    // Nothing b awaited was dropped, but its own response cleared a's points
    // before b's round ended: b plans its one second round over what is
    // missing, with the flank into its own [113, 153].
    expect(h.ranges()).toEqual([r(3, 103), r(113, 153), r(53, 113)]);
    expect(y.settled()).toBe(false);
    h.call(2).answer("v2");
    complete(await y.promise, r(53, 153));
    expect(h.calls).toHaveLength(3);
  });

  it("T19: a second-round joiner stops after its second drop, even when the issuer retries", async () => {
    const h = harness();
    const { a, b, x, y } = await overlap(h);
    const c = await h.connect();
    await a.request("clear", { cacheId: config.id });
    const z = h.get(c, r(3, 103));
    await h.turn(c);
    expect(h.ranges().at(-1)).toEqual(r(3, 103));
    h.call(0).answer();
    h.call(1).answer();
    await h.turn(a);
    await h.turn(b);
    expect(h.ranges()).toEqual([
      r(3, 103),
      r(113, 153),
      r(3, 103),
      r(113, 153),
    ]);
    await b.request("clearAll", {});
    h.call(2).answer();
    h.call(3).answer();
    await h.turn(a);
    await h.turn(b);
    await h.turn(c);
    expect((await x.promise).misses).toEqual([miss(3, 103, "uncached")]);
    expect((await y.promise).misses).toEqual([miss(53, 153, "uncached")]);
    expect(h.ranges().slice(4)).toEqual([r(3, 103)]);
    h.call(4).answer();
    complete(await z.promise, r(3, 103));
    expect(h.calls).toHaveLength(5);
  });

  it("T20: new credentials make old overlapping fetches unjoinable without dropping their success", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    await h.auth(a, { token: "old" });
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    await h.auth(b, { token: "new" });
    const y = h.get(b, r(53, 153));
    await h.turn(b);
    expect(h.ranges()).toEqual([r(3, 103), r(53, 153)]);
    expect(h.call(0).request.context).toEqual({ token: "old" });
    expect(h.call(1).request.context).toEqual({ token: "new" });
    h.call(1).answer();
    complete(await y.promise, r(53, 153));
    h.call(0).answer();
    complete(await x.promise, r(3, 103));
    const got = await h.get(b, r(3, 103), { cacheOnly: true }).promise;
    expect(Array.from(got.fields.volume ?? [])).toEqual(Array(11).fill(1));
  });

  it("T21: invalid auth bypasses every outstanding overlap at once", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const other = h.get(b, r(203, 203));
    await h.turn(b);
    h.call(1).fail(authError());
    await other.promise;
    const y = h.get(b, r(53, 153));
    await h.turn(b);
    expect(y.settled()).toBe(true);
    expect((await y.promise).misses).toEqual([miss(53, 153, "auth-pending")]);
    expect(h.calls).toHaveLength(2);
    await x.promise;
    h.call(0).answer();
    await h.turn(a);
  });

  it("T22: a slow updateAuth hook bypasses an otherwise joinable fetch", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    let release = () => {};
    let entered = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.hook = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    const updating = h.auth(a, { token: "new" });
    await started;
    const y = h.get(b, r(33, 73));
    await h.turn(b);
    expect(y.settled()).toBe(true);
    expect((await y.promise).misses).toEqual([miss(33, 73, "auth-pending")]);
    expect(h.calls).toHaveLength(1);
    release();
    await updating;
    h.call(0).answer();
    await x.promise;
  });

  it("T23: a joined 401 after own success broadcasts its context once to each client", async () => {
    const h = harness();
    const seed = await h.connect();
    await h.auth(seed, { token: "refused" });
    const { a, b, x, y } = await overlap(h);
    h.call(1).answer();
    await h.turn(b);
    expect(y.settled()).toBe(false);
    h.call(0).fail(authError());
    expect((await x.promise).misses).toEqual([miss(3, 103, "auth-pending")]);
    const got = await y.promise;
    expect(got.misses).toEqual([miss(53, 103, "auth-pending")]);
    expect(got.coverage).toEqual([r(113, 153)]);
    expect(Array.from(got.timestamps)).toEqual([113, 123, 133, 143, 153]);
    await h.turn(a);
    await h.turn(b);
    for (const seen of h.events)
      expect(
        seen.filter((e) => e.event === "authInvalid").map((e) => e.payload),
      ).toEqual([
        {
          error: { name: "Error", message: "401" },
          context: { token: "refused" },
        },
      ]);
  });

  it("T24: a joined 401 releases an own fetch still out, whose later success remains useful", async () => {
    const h = harness();
    const { b, x, y } = await overlap(h);
    h.call(0).fail(authError());
    await x.promise;
    await h.turn(b);
    expect(y.settled()).toBe(true);
    // Rule 4 defines labels per slot, but does not require adjacent equal
    // labels to be combined into a single Miss object (step T24 uses a
    // single span). Compare the labels without choosing that representation.
    const labels = (await y.promise).misses.flatMap((m) => {
      const slots = [];
      for (let t = m.range.start; t <= m.range.end; t += 10)
        slots.push({ t, reason: m.reason, error: m.error });
      return slots;
    });
    expect(labels).toEqual(
      Array.from({ length: 11 }, (_, i) => ({
        t: 53 + i * 10,
        reason: "auth-pending",
        error: undefined,
      })),
    );
    h.call(1).answer();
    await h.turn(b);
    complete(
      await h.get(b, r(113, 153), { cacheOnly: true }).promise,
      r(113, 153),
    );
  });

  it("T25: superseded joined 401 labels the overlap without invalidating new auth", async () => {
    const h = harness();
    const a = await h.connect();
    await h.auth(a, { token: "old" });
    const { b, x, y } = await overlap(h);
    await h.auth(b, { token: "new" });
    expect(
      h.calls.every(
        (call) => (call.request.context as { token: string }).token === "old",
      ),
    ).toBe(true);
    h.call(0).fail(authError());
    h.call(1).answer();
    await x.promise;
    const got = await y.promise;
    expect(got.misses).toEqual([miss(53, 103, "auth-pending")]);
    expect(got.coverage).toEqual([r(113, 153)]);
    expect(Array.from(got.timestamps)).toEqual([113, 123, 133, 143, 153]);
    await h.turn(a);
    await h.turn(b);
    expect(h.events.flat().filter((e) => e.event === "authInvalid")).toEqual(
      [],
    );
    const retry = h.get(b, r(53, 103));
    await h.turn(b);
    expect(h.ranges().at(-1)).toEqual(r(53, 113));
    expect(h.call(2).request.context).toEqual({ token: "new" });
    h.call(2).answer();
    complete(await retry.promise, r(53, 103));
  });

  it.each(["joins", "fetches", "both"])(
    "T26: one engine read when a get %s, with a coherent snapshot",
    async (mode) => {
      const h = harness();
      const o = await h.direct();
      const reads = vi.spyOn(h.engine, "get");
      const x = mode === "fetches" ? undefined : o.get(config.id, r(3, 103));
      const target = mode === "joins" ? r(33, 73) : r(53, 153);
      const y = o.get(config.id, target, { snapshot: true });
      expect(reads).toHaveBeenCalledTimes(0);
      expect(h.ranges()).toEqual(
        mode === "fetches"
          ? [r(53, 153)]
          : mode === "joins"
            ? [r(3, 103)]
            : [r(3, 103), r(113, 153)],
      );
      for (const call of h.calls) call.answer();
      await x;
      const got = await y;
      complete(got, target);
      expect(got.snapshot?.coverage).toEqual(got.coverage);
      expect(reads).toHaveBeenCalledTimes(x ? 2 : 1);
      expect(
        reads.mock.calls.filter(
          ([, range]) =>
            range.start === target.start && range.end === target.end,
        ),
      ).toHaveLength(1);
    },
  );

  it("T27: the failed range starting first labels a shared flank made missing by invalidate", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const c = await h.connect();
    await h.put(a, r(53, 53));
    const x = h.get(a, r(3, 43));
    await h.turn(a);
    const y = h.get(b, r(63, 103));
    await h.turn(b);
    const z = h.get(c, r(3, 103));
    await h.turn(c);
    expect(h.ranges()).toEqual([r(3, 53), r(53, 103)]);
    await h.invalidate(c, r(53, 53));
    h.call(1).fail(new Error("EB"));
    h.call(0).fail(new Error("EA"));
    await x.promise;
    await y.promise;
    expect((await z.promise).misses).toEqual([
      miss(3, 53, "fetch-failed", "EA"),
      miss(63, 103, "fetch-failed", "EB"),
    ]);
  });

  it.each([r(53, 63), r(54, 62)])(
    "T28: invalidate fences the whole intersecting entry, retains unrelated joins and still applies old responses (%j)",
    async (invalidated) => {
      const h = harness();
      const a = await h.connect();
      const b = await h.connect();
      const c = await h.connect();
      const d = await h.connect();
      const x = h.get(a, r(3, 103));
      await h.turn(a);
      const z = h.get(c, r(203, 303));
      await h.turn(c);
      await h.invalidate(b, invalidated);
      const y = h.get(b, r(83, 93));
      await h.turn(b);
      const w = h.get(d, r(253, 263));
      await h.turn(d);
      expect(h.ranges()).toEqual([r(3, 103), r(203, 303), r(83, 93)]);
      h.call(2).answer();
      complete(await y.promise, r(83, 93));
      h.call(0).answer();
      complete(await x.promise, r(3, 103));
      h.call(1).answer();
      complete(await z.promise, r(203, 303));
      complete(await w.promise, r(253, 263));
      expect(
        Array.from(
          (await h.get(b, r(83, 93), { cacheOnly: true }).promise).fields
            .volume ?? [],
        ),
      ).toEqual([1, 1]);
    },
  );

  it("T29: an invalid invalidate rejects before fencing any entry", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    await expect(h.invalidate(b, r(63, 53))).rejects.toBeInstanceOf(
      InvalidRangeError,
    );
    const y = h.get(b, r(33, 73));
    await h.turn(b);
    expect(h.calls).toHaveLength(1);
    h.call(0).answer();
    await x.promise;
    complete(await y.promise, r(33, 73));
  });

  it("T30: cacheOnly returns the current miss at once and a later normal get still joins", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const cached = await h.get(b, r(33, 73), { cacheOnly: true }).promise;
    expect(cached.misses).toEqual([miss(33, 73, "uncached")]);
    expect(x.settled()).toBe(false);
    const y = h.get(b, r(33, 73));
    await h.turn(b);
    expect(h.calls).toHaveLength(1);
    h.call(0).answer();
    await x.promise;
    complete(await y.promise, r(33, 73));
  });

  it("T31: disposing the issuer leaves its fetch serving another client", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const y = h.get(b, r(33, 73));
    await h.turn(b);
    expect(h.calls).toHaveLength(1);
    a.dispose();
    await x.promise.catch(() => {});
    h.call(0).answer();
    complete(await y.promise, r(33, 73));
    complete(await h.get(b, r(3, 103), { cacheOnly: true }).promise, r(3, 103));
  });

  it("T32: an overlapping read remains pending across an ordered cacheOnly round trip until release", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const y = h.get(b, r(53, 73));
    await h.turn(b);
    expect(h.calls).toHaveLength(1);
    expect(y.settled()).toBe(false);
    h.call(0).answer();
    await x.promise;
    complete(await y.promise, r(53, 73));
  });

  it("T33: concurrent live-tail reads share one fetch and retain the provisional point as uncached", async () => {
    const h = harness({ finalizedUntil: 103 });
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const y = h.get(b, r(3, 103));
    await h.turn(b);
    expect(h.calls).toHaveLength(1);
    h.call(0).answer();
    for (const got of await Promise.all([x.promise, y.promise])) {
      expect(Array.from(got.timestamps)).toEqual([
        3, 13, 23, 33, 43, 53, 63, 73, 83, 93, 103,
      ]);
      expect(got.coverage).toEqual([r(3, 93)]);
      expect(got.misses).toEqual([miss(103, 103, "uncached")]);
    }
  });

  it("R3-1 regression: a fetcher that throws instead of rejecting fails its range, and a later get fetches again", async () => {
    const h = harness();
    const o = await h.direct();
    const gate = (globalThis as unknown as { __n31: { fetch: unknown } }).__n31;
    const gated = gate.fetch;
    gate.fetch = () => {
      throw new Error("offline");
    };
    const failed = await o.get(config.id, r(3, 43));
    expect(failed.misses).toEqual([miss(3, 43, "fetch-failed", "offline")]);
    // No decided entry is left listed for the next get to join.
    gate.fetch = gated;
    const retry = o.get(config.id, r(3, 43));
    expect(h.calls).toHaveLength(1);
    h.call(0).answer();
    complete(await retry, r(3, 43));
  });

  it("R4-1 regression: a get reads in the step its last round ends, before another fetch's version clear lands", async () => {
    // The reviewer's interleaving: b's response, carrying a new version,
    // follows a's by five promise reactions. a's get must read in the step
    // its round ends; an extra await before the read let b's clear wipe a's
    // point first (an uncached miss with nothing dropped). Earlier landings
    // of b clear the cache before a's round ends, and a re-plans (N29 as
    // amended; the sweep F5 below). The count pins today's path from a
    // fetch's decision to the read: a change that lengthens it fails here.
    const h = harness();
    const o = await h.direct();
    const x = o.get(config.id, r(13, 13));
    const y = o.get(config.id, r(23, 23));
    expect(h.calls).toHaveLength(2);
    h.call(0).answer("v1");
    for (let i = 0; i < 5; i++) await Promise.resolve();
    h.call(1).answer("v2");
    complete(await x, r(13, 13));
    complete(await y, r(23, 23));
  });

  it("R3-1 regression: a fetcher that throws the auth marker leaves the get pending auth, not rejected", async () => {
    const h = harness();
    const o = await h.direct();
    const gate = (globalThis as unknown as { __n31: { fetch: unknown } }).__n31;
    gate.fetch = () => {
      throw authError();
    };
    const got = await o.get(config.id, r(3, 43));
    expect(got.misses).toEqual([miss(3, 43, "auth-pending")]);
  });
});

// N29 as amended on 2026-10-31 (user decision #10, option B; DC-1 in
// docs/reviews/step-44.md): a get also plans its one second round when the
// cache was cleared while its first round waited, whether or not a fetch it
// awaited was dropped (§4.9.1 rule 5). docs/reviews/step-47.md lists these.
describe("N29 as amended: a clear while a get waits re-plans once", () => {
  async function clearedWhileWaiting(h: Harness) {
    const seed = await h.connect();
    await version(h, seed, "v1");
    const a = await h.connect();
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    const z = h.get(seed, r(203, 253));
    await h.turn(seed);
    expect(h.ranges()).toEqual([r(3, 103), r(203, 253)]);
    return { seed, a, x, z };
  }

  it("F1: a get whose joined fetch is applied, then wiped by another response's clear, re-plans once and completes", async () => {
    const h = harness();
    const { seed, a, x, z } = await clearedWhileWaiting(h);
    const b = await h.connect();
    const y = h.get(b, r(33, 73));
    await h.turn(b);
    expect(h.calls).toHaveLength(2);
    // One step: a's fetch applies at v1, then the other brings v2 and clears
    // a's points before either get's round ends.
    h.call(0).answer("v1");
    h.call(1).answer("v2");
    await h.turn(a);
    await h.turn(b);
    await h.turn(seed);
    // a and b share the refetch: whichever re-plans first issues it.
    const retry = h.ranges().slice(2);
    uniqueUncovered(retry, r(3, 103));
    expect(retry.every((q) => q.start >= 3 && q.end <= 103)).toBe(true);
    expect(y.settled()).toBe(false);
    for (const call of h.calls.slice(2)) call.answer("v2");
    complete(await y.promise, r(33, 73));
    complete(await x.promise, r(3, 103));
    complete(await z.promise, r(203, 253));
  });

  it("F2: a get whose own fetch is applied, then wiped by another response's clear, re-plans once and completes", async () => {
    const h = harness();
    const { seed, a, x, z } = await clearedWhileWaiting(h);
    h.call(0).answer("v1");
    h.call(1).answer("v2");
    await h.turn(a);
    await h.turn(seed);
    // The clearing fetch's get re-plans too; none of its range is missing.
    expect(h.ranges()).toEqual([r(3, 103), r(203, 253), r(3, 103)]);
    complete(await z.promise, r(203, 253));
    expect(x.settled()).toBe(false);
    h.call(2).answer("v2");
    complete(await x.promise, r(3, 103));
    expect(h.calls).toHaveLength(3);
  });

  it.each(["wiped after it applied", "dropped"])(
    "F3: a clear during the second round is final: the range comes back uncached, with no third round (%s)",
    async (how) => {
      const h = harness();
      const { seed, a, x, z } = await clearedWhileWaiting(h);
      h.call(0).answer("v1");
      h.call(1).answer("v2");
      await h.turn(a);
      expect(h.ranges()).toEqual([r(3, 103), r(203, 253), r(3, 103)]);
      await z.promise;
      if (how === "dropped") {
        await version(h, seed, "v3");
        h.call(2).answer("v2");
      } else {
        // Issued after the first clear, so it is applied, and its v3 clears
        // a's second-round points before a's read.
        const w = h.get(seed, r(303, 353));
        await h.turn(seed);
        expect(h.ranges().at(-1)).toEqual(r(303, 353));
        h.call(2).answer("v2");
        h.call(3).answer("v3");
        complete(await w.promise, r(303, 353));
      }
      const got = await x.promise;
      expect(got.misses).toEqual([miss(3, 103, "uncached")]);
      expect(got.coverage).toEqual([]);
      await h.turn(a);
      await h.turn(seed);
      expect(h.calls).toHaveLength(how === "dropped" ? 3 : 4);
    },
  );

  it.each(["outside the range", "inside the range"])(
    "F4: a clear while a get waits costs one re-plan and fetches only what is missing (wiped %s)",
    async (where) => {
      const h = harness();
      const a = await h.connect();
      const inside = where === "inside the range";
      await h.put(a, inside ? r(3, 43) : r(203, 253), "v1");
      const coverage = vi.spyOn(h.engine, "coverage");
      const x = h.get(a, r(3, 103));
      await h.turn(a);
      expect(h.ranges()).toEqual([inside ? r(43, 103) : r(3, 103)]);
      // The get's own response brings v2: its put clears the cache, then
      // applies the response.
      h.call(0).answer("v2");
      await h.turn(a);
      if (inside) {
        // Only the wiped [3, 33], with the flank into the response's 43.
        expect(h.ranges().slice(1)).toEqual([r(3, 43)]);
        h.call(1).answer("v2");
      }
      complete(await x.promise, r(3, 103));
      expect(h.calls).toHaveLength(inside ? 2 : 1);
      // One coverage read per round: the first round and the one re-plan.
      expect(coverage).toHaveBeenCalledTimes(2);
    },
  );

  it.each([0, 1, 2, 3, 4, 5])(
    "F5: the R4-1 interleaving with the clearing response %i reactions after the first: both gets complete",
    async (reactions) => {
      const h = harness();
      const o = await h.direct();
      const x = o.get(config.id, r(13, 13));
      const y = o.get(config.id, r(23, 23));
      expect(h.calls).toHaveLength(2);
      // A re-plan's fetch is answered as it is issued.
      const gate = (
        globalThis as unknown as {
          __n31: { fetch: (q: FetchRequest) => Promise<FetchResponse> };
        }
      ).__n31;
      const gated = gate.fetch;
      gate.fetch = (request) => {
        const answer = gated(request);
        h.call(h.calls.length - 1).answer("v2");
        return answer;
      };
      h.call(0).answer("v1");
      for (let i = 0; i < reactions; i++) await Promise.resolve();
      h.call(1).answer("v2");
      complete(await x, r(13, 13));
      complete(await y, r(23, 23));
      // Whichever side of x's read the clear lands on, x fetches its point
      // at most once more, with the flank into y's.
      const later = h.ranges().slice(2);
      expect(later.length).toBeLessThanOrEqual(1);
      for (const q of later) expect(q).toEqual(r(13, 23));
    },
  );

  it("F6: a get released by an auth flip after a clear re-plans under the auth gate: the wiped slots come back auth-pending", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    await h.put(a, r(113, 153), "v1");
    const x = h.get(a, r(3, 153));
    await h.turn(a);
    expect(h.ranges()).toEqual([r(3, 113)]);
    // A newer version clears [113, 153]; a's fetch is still out.
    await version(h, b, "v2");
    const z = h.get(b, r(203, 253));
    await h.turn(b);
    h.call(1).fail(authError());
    const got = await x.promise;
    expect(got.coverage).toEqual([]);
    for (let t = 3; t <= 153; t += 10) {
      expect(
        got.misses.find((m) => m.range.start <= t && t <= m.range.end)?.reason,
        `slot ${t}`,
      ).toBe("auth-pending");
    }
    expect((await z.promise).misses).toEqual([miss(203, 253, "auth-pending")]);
    expect(h.calls).toHaveLength(2);
  });
});
