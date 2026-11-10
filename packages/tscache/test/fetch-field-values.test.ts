import { describe, expect, it, vi } from "vitest";
import type { FetchResponse } from "../src/types";
import { Harness, range } from "./orchestrator-subtraction-helpers";

describe("fetcher field values — architecture §2.4, §4.3, N68", () => {
  it("returns fetch-failed with PutError to both awaiting gets, caches nothing and retries", async () => {
    const h = new Harness({ version: "live" });
    try {
      const a = await h.connect();
      const b = await h.connect();
      const r = range(3, 13);
      const before = h.engine.snapshot(h.cfg.id, r);
      const first = h.get(a, r).promise;
      await vi.waitFor(() => expect(h.calls).toHaveLength(1));
      const second = h.get(b, r).promise;
      await h.turn(b);
      h.call(0).respond({
        timestamps: [3, 13],
        fields: { price: [1, null], volume: [1, 2] },
        meta: { version: "bad-version", finalizedUntil: 23 },
      } as unknown as FetchResponse);
      const results = await Promise.all([first, second]);
      expect(h.engine.snapshot(h.cfg.id, r)).toEqual(before);
      for (const got of results) {
        expect(got.timestamps).toEqual(new Float64Array());
        expect(got.coverage).toEqual([]);
        expect(got.misses).toEqual([
          {
            range: r,
            reason: "fetch-failed",
            error: {
              name: "PutError",
              message: expect.stringMatching(
                /field "price".*null.*index 1.*13/,
              ),
            },
          },
        ]);
      }
      const retry = h.get(a, r).promise;
      await vi.waitFor(() => expect(h.calls).toHaveLength(2));
      h.call(1).answer("live");
      expect((await retry).misses).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
