import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import {
  batch,
  change,
  config,
  id,
  observed,
  view,
} from "./m7-change-test-helpers";

afterEach(() => vi.unstubAllGlobals());

/**
 * The allocator seam used by segment-atomic-alloc.test.ts, gated by a
 * publicly readable point rather than a private run count or stack frame.
 * Snapshot decoding and validation can allocate freely; only a write
 * that has actually landed the chosen prefix can trip the fault (N70).
 */
function failAfterPoint(
  engine: Engine,
  timestamp: number,
  value: number,
  action: () => void,
): RangeError {
  const fault = new RangeError("M7 injected allocation failure");
  const NativeUint8Array = Uint8Array;
  let armed = true;
  let caught: unknown;
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(NativeUint8Array, {
      construct(target, args, newTarget) {
        if (armed && typeof args[0] === "number" && args[0] > 0) {
          const prefix = engine.get(id, { start: timestamp, end: timestamp });
          if (prefix.fields.value?.[0] === value) {
            armed = false;
            throw fault;
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
    }),
  );
  try {
    action();
  } catch (error) {
    caught = error;
  } finally {
    vi.unstubAllGlobals();
  }
  expect(armed, "the write must reach the injected allocation failure").toBe(
    false,
  );
  expect(caught, "the exact write error must propagate").toBe(fault);
  return fault;
}

describe("M7 failures still report readable changes (§5.6)", () => {
  it.each([
    { covered: false, mismatch: false },
    { covered: true, mismatch: false },
    { covered: false, mismatch: true },
    { covered: true, mismatch: true },
  ])(
    "failed put reports its entire touch, actual withdrawal and clear; $covered/$mismatch",
    ({ covered, mismatch }) => {
      const { engine, events, order, reset } = observed({ version: "v1" });
      if (covered) engine.put(id, batch([]), { range: { start: 3, end: 63 } });
      reset();
      failAfterPoint(engine, 3, 101, () => {
        engine.put(
          id,
          batch([3, 43], [101, 202], { version: mismatch ? "v2" : "v1" }),
        );
      });
      const result = engine.get(id, view);
      expect(result.timestamps).toEqual(new Float64Array([3]));
      expect(result.fields.value).toEqual(new Float64Array([101]));
      expect(engine.coverage(id, { start: 3, end: 43 })).toEqual([]);
      const event = change(
        [{ start: 3, end: 43 }],
        covered && !mismatch ? [{ start: 3, end: 43 }] : [],
        mismatch,
      );
      expect(events).toEqual([event]);
      expect(order).toEqual([
        ...(mismatch
          ? [{ kind: "cleared", cacheId: id, reason: "version-mismatch" }]
          : []),
        { kind: "changed", event },
      ]);
    },
  );

  it("failed replace reports empty flanks of its authority as touched too", () => {
    const { engine, events, reset } = observed();
    engine.put(id, batch([]), { range: { start: -17, end: 63 } });
    reset();
    failAfterPoint(engine, 3, 101, () => {
      engine.put(id, batch([3, 43], [101, 202]), {
        range: { start: -17, end: 63 },
      });
    });
    expect(events).toEqual([
      change([{ start: -17, end: 63 }], [{ start: -17, end: 63 }]),
    ]);
  });

  it("a failed wholly provisional write still reports written with no withdrawn coverage", () => {
    const { engine, events } = observed({ finalizedUntil: 3 });
    failAfterPoint(engine, 3, 101, () => {
      engine.put(id, batch([3, 43], [101, 202]));
    });
    expect(events).toEqual([change([{ start: 3, end: 43 }])]);
    expect(engine.get(id, view).timestamps).toEqual(new Float64Array([3]));
  });

  it.each([false, true])(
    "failed hydrate reports prior applied and attempted parts, including watermark withdrawal=%s",
    (withdraw) => {
      const source = new Engine();
      source.cache(config({ finalizedUntil: 73 }));
      source.put(id, batch([3], [11]), { range: { start: 3, end: 13 } });
      source.put(id, batch([33, 63], [101, 202]));
      const snapshot = source.snapshot(id, { start: 3, end: 63 });
      const { engine, events, reset } = observed();
      if (withdraw)
        engine.put(id, batch([]), { range: { start: 83, end: 103 } });
      reset();
      failAfterPoint(engine, 33, 101, () => {
        engine.hydrate(id, snapshot);
      });
      expect(engine.get(id, view).timestamps).toEqual(
        new Float64Array([3, 33]),
      );
      expect(engine.coverage(id, view)).toEqual([{ start: 3, end: 13 }]);
      expect(events).toEqual([
        change(
          [
            { start: 3, end: 13 },
            { start: 33, end: 63 },
          ],
          withdraw ? [{ start: 83, end: 103 }] : [],
        ),
      ]);
    },
  );
});
