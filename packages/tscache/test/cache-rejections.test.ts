import { describe, expect, it } from "vitest";
import { InvalidRangeError, type PutErrorCode } from "../src/errors";
import type { PutBatch, PutOptions, Range } from "../src/types";
import {
  batch,
  cache,
  expectPutError,
  malformedRanges,
  observe,
} from "./cache-test-helpers";

const rejected: {
  name: string;
  input: PutBatch;
  options?: PutOptions;
  code: PutErrorCode;
  offenderIndex: number;
}[] = [
  {
    name: "misaligned",
    input: batch([13, 14], [999, 999]),
    code: "misaligned",
    offenderIndex: 1,
  },
  {
    name: "unsorted",
    input: batch([13, 3], [999, 999]),
    code: "unsorted",
    offenderIndex: 1,
  },
  {
    name: "duplicate",
    input: batch([13, 13], [999, 999]),
    code: "duplicate",
    offenderIndex: 1,
  },
  {
    name: "range-mismatch",
    input: batch([13, 43], [999, 999]),
    options: { range: { start: 3, end: 33 } },
    code: "range-mismatch",
    offenderIndex: 1,
  },
  {
    name: "missing field",
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
];

describe("CacheState rejected puts — architecture §2.4, §2.6, §4.3, §4.5", () => {
  it.each(rejected)(
    "$name changes no data, coverage, config, version or watermark",
    ({ input, options, code, offenderIndex }) => {
      for (const versioned of [false, true]) {
        const c = cache({
          finalizedUntil: 33,
          ...(versioned ? { version: "v1" } : {}),
        });
        c.put(batch([-7, 3, 13, 23, 33]));
        const before = observe(c);
        expectPutError(
          () =>
            c.put(
              { ...input, meta: { version: "v2", finalizedUntil: 53 } },
              options,
            ),
          code,
          offenderIndex,
        );
        expect(observe(c)).toEqual(before);
      }
    },
  );

  it.each(malformedRanges)(
    "malformed put range %j rejects before metadata or replacement is applied",
    (range) => {
      const c = cache({ version: "v1", finalizedUntil: 33 });
      c.put(batch([-7, 3, 13, 23, 33]));
      const before = observe(c);
      const input = {
        ...batch([13], [999]),
        meta: { version: "v2", finalizedUntil: 53 },
      };
      expect(() => c.put(input, { range: range as Range })).toThrow(
        InvalidRangeError,
      );
      expect(observe(c)).toEqual(before);
    },
  );
});
