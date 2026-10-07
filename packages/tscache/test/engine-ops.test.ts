import { describe, expect, expectTypeOf, it } from "vitest";
import { Engine } from "../src/engine/engine";
import type { GetResult, PutBatch, PutOptions, PutResult } from "../src/types";
import { batch, engineConfig, result } from "./engine-test-helpers";

describe("Engine operation delegation — architecture §2.3–§2.4, §4.5–§4.6", () => {
  it("unranged puts upsert sparse points and cover only the batch span", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig());
    const put = engine.put(id, batch([13, 23, 33]));
    expectTypeOf(put).toEqualTypeOf<PutResult>();
    expect(put).toEqual({ warnings: [] });
    expect(Reflect.ownKeys(put)).toEqual(["warnings"]);
    expect(put).not.toHaveProperty("cleared");
    engine.put(id, batch([13, 33], [130, 330]));
    const read = engine.get(id, { start: 3, end: 43 });
    expectTypeOf(read).toEqualTypeOf<GetResult>();
    expect(read).toEqual(
      result(
        [13, 23, 33],
        [{ start: 13, end: 33 }],
        [
          { start: 3, end: 3 },
          { start: 43, end: 43 },
        ],
        [130, 23, 330],
      ),
    );
  });

  it("a ranged put replaces only its inward snap and confirms empty flanks", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig());
    engine.put(id, batch([-7, 3, 13, 23, 33, 43, 53]));
    const options: PutOptions = { range: { start: 4, end: 42 } };
    expect(engine.put(id, batch([23], [230]), options)).toEqual({
      warnings: [],
    });
    expect(engine.get(id, { start: -7, end: 53 })).toEqual(
      result(
        [-7, 3, 23, 43, 53],
        [{ start: -7, end: 53 }],
        [],
        [-7, 3, 230, 43, 53],
      ),
    );
    expect(engine.get(id, { start: 13, end: 13 })).toEqual(
      result([], [{ start: 13, end: 13 }], []),
    );
  });

  it("empty puts without authority are inert and with authority replace by a real gap", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig());
    engine.put(id, batch([13, 23]));
    const before = engine.get(id, { start: 3, end: 43 });
    expect(engine.put(id, batch([]))).toEqual({ warnings: [] });
    expect(engine.put(id, batch([]), { range: { start: 4, end: 12 } })).toEqual(
      { warnings: [] },
    );
    expect(engine.get(id, { start: 3, end: 43 })).toEqual(before);
    engine.put(id, batch([]), { range: { start: 2, end: 34 } });
    expect(engine.get(id, { start: 3, end: 43 })).toEqual(
      result([], [{ start: 3, end: 33 }], [{ start: 43, end: 43 }]),
    );
  });

  it("get and invalidate snap outward, retaining uncovered points with exact misses", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig());
    engine.put(id, batch([-17, 3, 23, 43]), { range: { start: -17, end: 43 } });
    engine.invalidate(id, { start: -6.75, end: 12.75 });
    expect(engine.get(id, { start: -16.5, end: 32.5 })).toEqual(
      result(
        [-17, 3, 23],
        [
          { start: -17, end: -17 },
          { start: 23, end: 33 },
        ],
        [{ start: -7, end: 13 }],
      ),
    );
    engine.invalidate(id, { start: -6.75, end: 12.75 });
    expect(engine.get(id, { start: 3, end: 3 })).toEqual(
      result([3], [], [{ start: 3, end: 3 }]),
    );
  });

  it("typed-array inputs convert to schema dtypes and reads own their arrays and ranges", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ finalizedUntil: 13 }));
    const input: PutBatch = {
      timestamps: new Float64Array([3, 13]),
      fields: {
        price: new Float32Array([Number.NaN, 1.5]),
        volume: new Float64Array([1.9, -2.9]),
      },
    };
    engine.put(id, input);
    const expected = result(
      [3, 13],
      [{ start: 3, end: 3 }],
      [{ start: 13, end: 23 }],
      [Number.NaN, 1.5],
      [1, -2],
    );
    const read = engine.get(id, { start: 3, end: 23 });
    expect(read).toEqual(expected);
    read.timestamps.fill(999);
    read.fields.price?.fill(999);
    read.fields.volume?.fill(999);
    const covered = read.coverage[0];
    const miss = read.misses[0];
    if (!covered || !miss) throw new Error("Missing expected ranges");
    covered.start = -197;
    miss.range.end = 203;
    read.coverage.length = 0;
    read.misses.length = 0;
    expect(engine.get(id, { start: 3, end: 23 })).toEqual(expected);
  });

  it("setFinalizedUntil withdraws coverage backwards and never promotes old provisional points forwards", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ finalizedUntil: 43 }));
    engine.put(id, batch([3, 13, 23, 33, 43]));
    engine.setFinalizedUntil(id, 13.25);
    expect(engine.get(id, { start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 43 }],
      ),
    );
    engine.setFinalizedUntil(id, 43);
    expect(engine.get(id, { start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [{ start: 3, end: 13 }],
        [{ start: 23, end: 43 }],
      ),
    );
    engine.put(id, batch([23, 33], [230, 330]));
    expect(engine.get(id, { start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [{ start: 3, end: 33 }],
        [{ start: 43, end: 43 }],
        [3, 13, 230, 330, 43],
      ),
    );
  });

  it("a late response with an older watermark cannot rewind, delete or confirm its provisional tail (N17, N19)", () => {
    const engine = new Engine();
    const { id } = engine.cache(engineConfig({ finalizedUntil: 43 }));
    engine.put(id, batch([3, 13, 23, 33, 43, 53]), {
      range: { start: 3, end: 53 },
    });
    engine.put(
      id,
      { ...batch([23], [230]), meta: { finalizedUntil: 13 } },
      { range: { start: 3, end: 53 } },
    );
    expect(engine.get(id, { start: 3, end: 53 })).toEqual(
      result(
        [13, 23, 33, 43, 53],
        [{ start: 3, end: 33 }],
        [{ start: 43, end: 53 }],
        [13, 230, 33, 43, 53],
      ),
    );
    engine.put(id, batch([33, 43, 53], [330, 430, 530]));
    expect(engine.get(id, { start: 3, end: 53 })).toEqual(
      result(
        [13, 23, 33, 43, 53],
        [{ start: 3, end: 33 }],
        [{ start: 43, end: 53 }],
        [13, 230, 330, 430, 530],
      ),
    );
  });

  it("meta advances the watermark before warning filtering and records only the current final claim", () => {
    const engine = new Engine();
    const { id } = engine.cache(
      engineConfig({ finalizedUntil: 23, warnOnOverlapDiff: true }),
    );
    engine.put(id, batch([3, 13, 23, 33, 43]));
    expect(
      engine.put(id, {
        ...batch([33, 43], [330, 430]),
        meta: { finalizedUntil: 43 },
      }),
    ).toEqual({
      warnings: [{ range: { start: 33, end: 33 }, fields: ["price"] }],
    });
    expect(engine.get(id, { start: 3, end: 43 })).toEqual(
      result(
        [3, 13, 23, 33, 43],
        [
          { start: 3, end: 13 },
          { start: 33, end: 33 },
        ],
        [
          { start: 23, end: 23 },
          { start: 43, end: 43 },
        ],
        [3, 13, 23, 330, 430],
      ),
    );
  });

  it.each([false, true])(
    "put returns exactly warnings with overlap detection enabled=%s",
    (warnOnOverlapDiff) => {
      const engine = new Engine();
      const { id } = engine.cache(
        engineConfig({ warnOnOverlapDiff, finalizedUntil: 23 }),
      );
      expect(engine.put(id, batch([3, 13, 23]))).toEqual({ warnings: [] });
      expect(engine.put(id, batch([3, 13, 23], [30, 130, 230]))).toEqual({
        warnings: warnOnOverlapDiff
          ? [{ range: { start: 3, end: 13 }, fields: ["price"] }]
          : [],
      });
    },
  );
});
