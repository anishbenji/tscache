// The cases on which the native base64 path and the fallback must agree
// (src/base64.ts). Shared by base64.test.ts, which runs them in Vitest's
// Node, and by the Bun process it starts, whose runtime has the native API.

import type { EncodedSnapshot, Snapshot } from "../src/types";

/** What src/base64.ts exports. */
export interface Base64Module {
  toBase64(bytes: Uint8Array): string;
  fromBase64(text: string): Uint8Array<ArrayBuffer>;
  encodeBinary(bytes: Uint8Array): string;
  decodeBinary(text: string): Uint8Array<ArrayBuffer>;
}

/** btoa's chunk in the fallback encoder. */
const CHUNK = 0x8000;

/** Seeded bytes, so a failure reproduces. */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1_103_515_245 + 12_345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

/** Field data as a snapshot carries it: NaN, infinities, signed zero. */
function floats(): Uint8Array {
  const values = [Number.NaN, -0, 0, Infinity, -Infinity, 1.5, -2, 1e-310];
  return new Uint8Array(new Float64Array(values).buffer);
}

/** Byte inputs: empty, every length mod 3, the chunk's edges, NaN floats. */
function byteCases(): { name: string; bytes: Uint8Array }[] {
  const lengths = [0, 1, 2, 3, 4, 5, 7, 8, 13, 255, 1000];
  const out = lengths.map((n) => ({ name: `${n} bytes`, bytes: bytes(n, n) }));
  for (const n of [CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 2]) {
    out.push({ name: `${n} bytes`, bytes: bytes(n, n) });
  }
  out.push({
    name: "every byte value",
    bytes: Uint8Array.from({ length: 256 }, (_, i) => i),
  });
  out.push({ name: "NaN and other floats", bytes: floats() });
  // A view into a larger buffer: only the view is encoded.
  out.push({ name: "an offset view", bytes: bytes(64, 9).subarray(5, 38) });
  return out;
}

/**
 * Text inputs at the edges of what `atob` accepts: padding present or
 * not, misplaced or too much, whitespace of each kind, non-zero padding
 * bits, the URL-safe alphabet, characters outside Latin-1.
 */
const textCases: readonly string[] = [
  "",
  "QQ==",
  "QQ",
  "QQ=",
  "QQ===",
  "=QQ=",
  "QQ==QQ==",
  "QR==",
  "QUI=",
  "QUJ=",
  "QUJD",
  "QUJDRA",
  "QUJDRA=",
  "QUJDRB==",
  "QUJDREU",
  "Q",
  "QUJDR",
  " Q Q = = ",
  "Q\tQ\n==",
  "QQ\f==",
  "QQ\r==",
  "QQ\v==",
  "QQ ==",
  "QUJD\n",
  "QQ= =",
  "QQ=\n=",
  "Q-_",
  "+/+/",
  "ab=c",
  "Ā",
  "QUJD\u0000",
];

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** What decoding `text` gives: its bytes, or that it threw. */
function decoded(decode: (text: string) => Uint8Array, text: string) {
  try {
    return { bytes: decode(text) };
  } catch {
    return { threw: true as const };
  }
}

/**
 * Where `m`'s chosen path and its fallback disagree, as readable lines:
 * empty when they agree on every case. Also checks that encodings decode
 * back to the same bytes, in buffers of exactly their length.
 */
export function mismatches(m: Base64Module): string[] {
  const out: string[] = [];
  for (const { name, bytes: input } of byteCases()) {
    const text = m.toBase64(input);
    if (text !== m.encodeBinary(input)) out.push(`encode ${name}`);
    for (const decode of [m.fromBase64, m.decodeBinary]) {
      const back = decode(text);
      if (!same(back, input) || back.buffer.byteLength !== input.length) {
        out.push(`round trip ${name}`);
      }
    }
  }
  for (const text of textCases) {
    const chosen = decoded(m.fromBase64, text);
    const fallback = decoded(m.decodeBinary, text);
    const agree =
      "bytes" in chosen && "bytes" in fallback
        ? same(chosen.bytes, fallback.bytes)
        : "threw" in chosen && "threw" in fallback;
    if (!agree) out.push(`decode ${JSON.stringify(text)}`);
  }
  return out;
}

/** What src/snapshot.ts exports. */
export interface SnapshotCodec {
  encodeSnapshot(snapshot: Snapshot): EncodedSnapshot;
  decodeSnapshot(encoded: EncodedSnapshot): Snapshot;
}

/**
 * A snapshot whose buffers have odd and even byte lengths and NaN: points
 * at 3, 13 (NaN), 23 and 63 of seven slots, so a one-byte mask, a u8
 * field of 7 bytes, i16 of 14 and f64 of 56; plus an empty segment's
 * buffers.
 */
export function snapshotCase(): Snapshot {
  const segment = (start: number, count: number, mask: number[]) => ({
    format: 1 as const,
    layout: "dense" as const,
    start,
    count,
    interval: 10,
    alignmentOffset: 3,
    mask: new Uint8Array(mask),
    fields: [
      {
        name: "price",
        dtype: "f64" as const,
        data: Float64Array.from({ length: count }, (_, i) =>
          i === 1 ? Number.NaN : i * 1.5,
        ).buffer,
      },
      {
        name: "volume",
        dtype: "i16" as const,
        data: Int16Array.from({ length: count }, (_, i) => -i).buffer,
      },
      {
        name: "flag",
        dtype: "u8" as const,
        data: Uint8Array.from({ length: count }, (_, i) => i * 31).buffer,
      },
    ],
  });
  return {
    format: 1,
    interval: 10,
    alignmentOffset: 3,
    fields: { price: "f64", volume: "i16", flag: "u8" },
    range: { start: 3, end: 153 },
    coverage: [{ start: 3, end: 73 }],
    segments: [segment(3, 7, [0b0100_0111]), segment(103, 0, [])],
  };
}

/**
 * Where `codec`'s encoding of snapshotCase() differs from the fallback
 * encoder's text, or does not decode back to the same bytes and NaN.
 */
export function snapshotMismatches(
  codec: SnapshotCodec,
  m: Base64Module,
): string[] {
  const out: string[] = [];
  const snapshot = snapshotCase();
  const encoded = codec.encodeSnapshot(snapshot);
  const back = codec.decodeSnapshot(
    JSON.parse(JSON.stringify(encoded)) as EncodedSnapshot,
  );
  for (const [i, p] of snapshot.segments.entries()) {
    const e = encoded.segments[i];
    const d = back.segments[i];
    if (e?.mask !== m.encodeBinary(p.mask)) out.push(`mask ${i}`);
    if (d === undefined || !same(d.mask, p.mask)) out.push(`mask back ${i}`);
    for (const [k, f] of p.fields.entries()) {
      const raw = new Uint8Array(f.data);
      if (e?.fields[k]?.data !== m.encodeBinary(raw)) {
        out.push(`data ${i}.${f.name}`);
      }
      const data = d?.fields[k]?.data;
      if (data === undefined || !same(new Uint8Array(data), raw)) {
        out.push(`data back ${i}.${f.name}`);
      }
    }
  }
  const price = back.segments[0]?.fields[0]?.data;
  if (price === undefined || !Number.isNaN(new Float64Array(price)[1])) {
    out.push("NaN lost");
  }
  return out;
}
