import { expect, it } from "vitest";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot";
import type { Snapshot } from "../src/types";
import { batch, engine, ID, span, utc } from "./calendar-contract-helpers";

// Implementer tests added after pre-review 1 and security lane 1 of step
// 129 (docs/reviews/step-129.md): each pins a behaviour that no test did.

// Test 14 and §3.4: a fixed cache's payloads and snapshot text are, byte
// for byte, what 0.2.0 wrote, key order included: a page's snapshot text
// and any hash of it stay the same for the same data.
it("14: a fixed cache's snapshot keeps the key order and JSON text of 0.2.0", () => {
  const e = engine(10, { alignmentOffset: 3 });
  e.put(ID, batch([3, 23], [1, Number.NaN]));
  const snapshot = e.snapshot(ID, span(3, 23));
  expect(Object.keys(snapshot)).toEqual([
    "format",
    "interval",
    "alignmentOffset",
    "fields",
    "range",
    "coverage",
    "segments",
  ]);
  expect(Object.keys(snapshot.segments[0] as object)).toEqual([
    "format",
    "layout",
    "start",
    "count",
    "interval",
    "alignmentOffset",
    "mask",
    "fields",
  ]);
  const text = JSON.stringify(encodeSnapshot(snapshot));
  expect(text).toBe(
    '{"format":1,"interval":10,"alignmentOffset":3,"fields":{"value":"f64"},' +
      '"range":{"start":3,"end":23},"coverage":[{"start":3,"end":23}],' +
      '"segments":[{"format":1,"layout":"dense","start":3,"count":3,' +
      '"interval":10,"alignmentOffset":3,"mask":"BQ==",' +
      '"fields":[{"name":"value","dtype":"f64","data":"AAAAAAAA8D8AAAAAAAAAAAAAAAAAAPh/"}]}]}',
  );
  // Decoding and encoding again gives the same text.
  expect(JSON.stringify(encodeSnapshot(decodeSnapshot(JSON.parse(text))))).toBe(
    text,
  );
});

it("14: a calendar cache's snapshot has one key order and JSON text", () => {
  const e = engine({ unit: "month" });
  const feb = utc("2024-02-01");
  e.put(ID, batch([feb], [1]));
  const snapshot: Snapshot = e.snapshot(ID, span(feb));
  const text = JSON.stringify(encodeSnapshot(snapshot));
  expect(text).toBe(
    '{"format":2,"grid":{"unit":"month","zone":"UTC","at":"00:00"},' +
      '"fields":{"value":"f64"},"range":{"start":1706745600000,"end":1706745600000},' +
      '"coverage":[{"start":1706745600000,"end":1706745600000}],' +
      '"rangeSlots":[649,649],"coverageSlots":[[649,649]],' +
      '"segments":[{"format":2,"layout":"dense","start":1706745600000,"count":1,' +
      '"grid":{"unit":"month","zone":"UTC","at":"00:00"},"startSlot":649,"mask":"AQ==",' +
      '"fields":[{"name":"value","dtype":"f64","data":"AAAAAAAA8D8="}]}]}',
  );
  // Decoding and encoding again gives the same text.
  expect(JSON.stringify(encodeSnapshot(decodeSnapshot(JSON.parse(text))))).toBe(
    text,
  );
});
