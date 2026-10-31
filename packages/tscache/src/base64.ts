/**
 * Base64 of bytes for the snapshot encoding (docs/architecture.md §2.8,
 * N38). Uses `Uint8Array.prototype.toBase64` and `Uint8Array.fromBase64`
 * where the runtime has them (Chrome 140, Firefox 133, Safari 18.2, Bun,
 * Node 25), detected once at load, and `btoa`/`atob` otherwise. Both
 * encode to the same text. `fromBase64` with its default
 * `lastChunkHandling: "loose"` decodes as `atob` does (standard alphabet,
 * padding optional, ASCII whitespace skipped, non-zero padding bits
 * ignored), which test/base64.test.ts checks case by case in a runtime
 * that has it. No DOM: browsers and Node have both.
 */

/** The native API, absent from the ES2023 library types. */
type NativeEncode = (this: Uint8Array) => string;
type NativeDecode = (text: string) => Uint8Array<ArrayBuffer>;

/** btoa takes a binary string; String.fromCharCode takes bounded arguments. */
const CHUNK = 0x8000;

/** The fallback encoder: a binary string through `btoa`. */
export function encodeBinary(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** The fallback decoder: `atob`, then its characters' codes. Throws on invalid input. */
export function decodeBinary(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Taken once, at load: what the runtime offered then decides for good.
const encodeNative = (Uint8Array.prototype as { toBase64?: NativeEncode })
  .toBase64;
const decodeNative = (Uint8Array as { fromBase64?: NativeDecode }).fromBase64;
const native =
  typeof encodeNative === "function" && typeof decodeNative === "function";

/** The bytes as standard, padded base64. */
export const toBase64: (bytes: Uint8Array) => string = native
  ? (bytes) => (encodeNative as NativeEncode).call(bytes)
  : encodeBinary;

/**
 * The bytes of base64 text, in a buffer of exactly their length. Throws
 * (a SyntaxError natively, a DOMException from `atob`) on invalid input.
 */
export const fromBase64: (text: string) => Uint8Array<ArrayBuffer> = native
  ? (text) => (decodeNative as NativeDecode).call(Uint8Array, text)
  : decodeBinary;
