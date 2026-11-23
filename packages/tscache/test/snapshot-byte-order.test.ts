import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeSnapshot, encodeSnapshot } from "../src/snapshot";
import { snapshotFixture, thrown } from "./snapshot-test-helpers";

/** A `Uint16Array` that stores its elements as a big-endian host would. */
class BigEndianUint16Array extends Uint16Array {
  constructor(values: readonly number[]) {
    super(values.length);
    const view = new DataView(this.buffer);
    values.forEach((value, i) => {
      view.setUint16(i * 2, value, false);
    });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("snapshot byte order — architecture §3.4 (field data is little-endian)", () => {
  it("encodes and decodes on this little-endian host", () => {
    const encoded = encodeSnapshot(snapshotFixture());
    expect(decodeSnapshot(encoded)).toEqual(snapshotFixture());
  });

  it("encodeSnapshot throws TscacheError on a big-endian host", () => {
    const snapshot = snapshotFixture();
    vi.stubGlobal("Uint16Array", BigEndianUint16Array);
    const error = thrown(() => encodeSnapshot(snapshot));
    expect(error.message).toBe("snapshots need a little-endian host");
  });

  it("decodeSnapshot throws TscacheError on a big-endian host", () => {
    const encoded = encodeSnapshot(snapshotFixture());
    vi.stubGlobal("Uint16Array", BigEndianUint16Array);
    const error = thrown(() => decodeSnapshot(encoded));
    expect(error.message).toBe("snapshots need a little-endian host");
  });
});
