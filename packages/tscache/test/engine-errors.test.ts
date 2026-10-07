import { describe, expect, it } from "vitest";
import { Engine, type EngineEvents } from "../src/engine/engine";
import {
  InvalidRangeError,
  PutError,
  type PutErrorCode,
  UnknownCacheError,
} from "../src/errors";
import type { PutBatch, PutOptions } from "../src/types";
import { batch, engineConfig, result } from "./engine-test-helpers";

describe("Engine unknown ids — architecture §2.6, §4.6", () => {
  const actions: { name: string; call: (engine: Engine) => unknown }[] = [
    { name: "get", call: (e) => e.get("missing", { start: 3, end: 13 }) },
    {
      name: "get with invalid range",
      call: (e) => e.get("missing", { start: Number.NaN, end: 3 }),
    },
    { name: "put", call: (e) => e.put("missing", batch([3])) },
    {
      name: "put with invalid options",
      call: (e) =>
        e.put("missing", batch([3]), { range: { start: 13, end: 3 } }),
    },
    {
      name: "put with invalid metadata",
      call: (e) => e.put("missing", { ...batch([3]), meta: { version: "" } }),
    },
    {
      name: "put with invalid batch and options",
      call: (e) =>
        e.put(
          "missing",
          { timestamps: [4, 3], fields: {} },
          { range: { start: 13, end: 3 } },
        ),
    },
    {
      name: "invalidate",
      call: (e) => e.invalidate("missing", { start: 3, end: 13 }),
    },
    {
      name: "invalidate with invalid range",
      call: (e) => e.invalidate("missing", { start: 13, end: 3 }),
    },
    { name: "clear", call: (e) => e.clear("missing") },
    {
      name: "setFinalizedUntil",
      call: (e) => e.setFinalizedUntil("missing", 23),
    },
    {
      name: "setFinalizedUntil with invalid timestamp",
      call: (e) => e.setFinalizedUntil("missing", Number.NaN),
    },
  ];

  it.each(actions)(
    "$name throws UnknownCacheError before other validation",
    ({ call }) => {
      const engine = new Engine();
      const config = engineConfig();
      engine.cache(config);
      engine.put(config.id, batch([3, 13]));
      const events: EngineEvents["cacheCleared"][] = [];
      engine.on("cacheCleared", (event) => events.push(event));
      expect(() => call(engine)).toThrow(UnknownCacheError);
      expect(engine.get(config.id, { start: 3, end: 13 })).toEqual(
        result([3, 13], [{ start: 3, end: 13 }], []),
      );
      expect(events).toEqual([]);
    },
  );
});

describe("Engine errors propagate atomically — architecture §2.6, §4.5–§4.6", () => {
  const rejected: {
    name: string;
    input: PutBatch;
    options?: PutOptions;
    code: PutErrorCode;
    offenderIndex: number;
  }[] = [
    {
      name: "misaligned",
      input: batch([13, 14]),
      code: "misaligned",
      offenderIndex: 1,
    },
    {
      name: "unsorted",
      input: batch([13, 3]),
      code: "unsorted",
      offenderIndex: 1,
    },
    {
      name: "duplicate",
      input: batch([13, 13]),
      code: "duplicate",
      offenderIndex: 1,
    },
    {
      name: "field-mismatch",
      input: { timestamps: [13], fields: { price: [999] } },
      code: "field-mismatch",
      offenderIndex: -1,
    },
    {
      name: "length-mismatch",
      input: batch([13, 23], [999]),
      code: "length-mismatch",
      offenderIndex: -1,
    },
    {
      name: "range-mismatch",
      input: batch([13, 43]),
      options: { range: { start: 3, end: 33 } },
      code: "range-mismatch",
      offenderIndex: 1,
    },
    {
      name: "invalid meta",
      input: { ...batch([13]), meta: { version: "" } },
      code: "field-mismatch",
      offenderIndex: -1,
    },
  ];

  it.each(rejected)(
    "$name propagates PutError without clearing or changing state",
    ({ input, options, code, offenderIndex }) => {
      const engine = new Engine();
      const { id } = engine.cache(
        engineConfig({ version: "v1", finalizedUntil: 33 }),
      );
      engine.put(id, batch([3, 13, 23, 33]));
      const before = engine.get(id, { start: 3, end: 53 });
      const events: EngineEvents["cacheCleared"][] = [];
      engine.on("cacheCleared", (event) => events.push(event));
      let caught: unknown;
      try {
        engine.put(
          id,
          {
            ...input,
            meta: { version: "v2", finalizedUntil: 53, ...input.meta },
          },
          options,
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PutError);
      expect(caught).toMatchObject({ code, offenderIndex });
      if (code === "misaligned") {
        expect(caught).toMatchObject({
          offenderTimestamp: 14,
          expected: expect.stringMatching(/3.*10/),
        });
      }
      expect(engine.get(id, { start: 3, end: 53 })).toEqual(before);
      engine.put(id, { ...batch([43]), meta: { version: "v1" } });
      expect(engine.get(id, { start: 3, end: 53 })).toEqual(
        result(
          [3, 13, 23, 33, 43],
          [{ start: 3, end: 23 }],
          [{ start: 33, end: 53 }],
        ),
      );
      expect(events).toEqual([]);
    },
  );

  it.each([
    { start: Number.NaN, end: 23 },
    { start: 23, end: 3 },
    { start: 3, end: Infinity },
  ])(
    "malformed range %j propagates InvalidRangeError without changing state",
    (range) => {
      const engine = new Engine();
      const { id } = engine.cache(
        engineConfig({ version: "v1", finalizedUntil: 33 }),
      );
      engine.put(id, batch([3, 13, 23, 33]));
      const before = engine.get(id, { start: 3, end: 43 });
      expect(() => engine.get(id, range)).toThrow(InvalidRangeError);
      expect(() => engine.invalidate(id, range)).toThrow(InvalidRangeError);
      expect(() =>
        engine.put(
          id,
          { ...batch([13]), meta: { version: "v2", finalizedUntil: 53 } },
          { range },
        ),
      ).toThrow(InvalidRangeError);
      expect(engine.get(id, { start: 3, end: 43 })).toEqual(before);
    },
  );

  it.each([Number.NaN, Infinity, 2 ** 53, Number.MAX_SAFE_INTEGER])(
    "invalid watermark %j propagates InvalidRangeError without changing state",
    (watermark) => {
      const engine = new Engine();
      const { id } = engine.cache(engineConfig({ finalizedUntil: 33 }));
      engine.put(id, batch([3, 13, 23, 33]));
      const before = engine.get(id, { start: 3, end: 43 });
      expect(() => engine.setFinalizedUntil(id, watermark)).toThrow(
        InvalidRangeError,
      );
      expect(engine.get(id, { start: 3, end: 43 })).toEqual(before);
    },
  );
});
