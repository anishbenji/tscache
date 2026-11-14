import { afterEach, describe, expect, it } from "vitest";
import { Harness, miss, range as r } from "./orchestrator-subtraction-helpers";

// Implementer tests: how a get labels its remaining misses with the fetches
// it awaited (§4.9.1 rule 4), and that a decided fetch leaves the in-flight
// list (rule 1). Gates and ordered port round trips fix every interleaving.
const active: Harness[] = [];
function harness() {
  const h = new Harness();
  active.push(h);
  return h;
}
afterEach(async () => {
  for (const h of active.splice(0)) await h.close();
});

describe("miss labels (§4.9.1 rule 4)", () => {
  it.each([
    { name: "last", first: r(3, 43), second: r(43, 83) },
    { name: "first", first: r(43, 83), second: r(3, 43) },
  ])(
    "a failed joined fetch meeting the miss only at its $name slot labels that slot",
    async ({ first, second }) => {
      const h = harness();
      const a = await h.connect();
      const b = await h.connect();
      const x = h.get(a, first);
      await h.turn(a);
      const y = h.get(b, second);
      await h.turn(b);
      // y joins x for the shared slot 43 and fetches the rest itself.
      expect(h.ranges()).toHaveLength(2);
      h.call(1).answer();
      h.call(0).fail(new Error("E"));
      await x.promise;
      expect((await y.promise).misses).toEqual([
        miss(43, 43, "fetch-failed", "E"),
      ]);
    },
  );

  it("the fetch starting first labels its piece although it was awaited last", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const x = h.get(a, r(53, 103));
    await h.turn(a);
    // y joins x (awaited first) and fetches [3, 43] itself (awaited second).
    const y = h.get(b, r(3, 103));
    await h.turn(b);
    expect(h.ranges()).toEqual([r(53, 103), r(3, 43)]);
    h.call(0).fail(new Error("EA"));
    h.call(1).fail(new Error("EB"));
    await x.promise;
    expect((await y.promise).misses).toEqual([
      miss(3, 43, "fetch-failed", "EB"),
      miss(53, 103, "fetch-failed", "EA"),
    ]);
  });

  it("a miss starting before the first failed fetch keeps its front uncached", async () => {
    const h = harness();
    const a = await h.connect();
    await h.put(a, r(3, 23));
    const x = h.get(a, r(3, 103));
    await h.turn(a);
    expect(h.ranges()).toEqual([r(23, 103)]);
    // Invalidated while the fetch is out: the miss now starts at 3, before
    // the failed fetch's range.
    await h.invalidate(a, r(3, 23));
    h.call(0).fail(new Error("E"));
    expect((await x.promise).misses).toEqual([
      miss(3, 13, "uncached"),
      miss(23, 103, "fetch-failed", "E"),
    ]);
  });
});

describe("decided fetches (§4.9.1 rule 1)", () => {
  it("a failed fetch listed second leaves the in-flight list: the next get fetches afresh", async () => {
    const h = harness();
    const a = await h.connect();
    const b = await h.connect();
    const c = await h.connect();
    const x = h.get(a, r(3, 43));
    await h.turn(a);
    const y = h.get(b, r(103, 143));
    await h.turn(b);
    // Both in flight; [103, 143] is the second entry of the list.
    expect(h.ranges()).toEqual([r(3, 43), r(103, 143)]);
    h.call(1).fail(new Error("E"));
    expect((await y.promise).misses).toEqual([
      miss(103, 143, "fetch-failed", "E"),
    ]);
    const z = h.get(c, r(103, 143));
    await h.turn(c);
    expect(h.ranges()).toEqual([r(3, 43), r(103, 143), r(103, 143)]);
    h.call(2).answer();
    expect((await z.promise).misses).toEqual([]);
    h.call(0).answer();
    expect((await x.promise).misses).toEqual([]);
  });
});
