import { describe, expect, it, vi } from "vitest";
import * as base64 from "../src/base64";
import * as codec from "../src/snapshot";
import {
  type Base64Module,
  mismatches,
  snapshotCase,
  snapshotMismatches,
} from "./base64-cases";

// Implementer tests (architecture §2.8, N38): the snapshot encoding uses
// the native Uint8Array base64 methods where the runtime has them and
// btoa/atob otherwise, with the same text and the same accepted input
// either way. Vitest runs under Node 24, which lacks the native methods,
// so the native path is checked in a Bun process, whose runtime has them.

/** Node's child_process, through a specifier TypeScript does not resolve (vite-fetcher-url.test.ts). */
const load = <T>(specifier: string): Promise<T> =>
  import(/* @vite-ignore */ specifier) as Promise<T>;
const { fileURLToPath } = await load<{ fileURLToPath(url: string): string }>(
  "node:url",
);
const { execFile } = await load<{
  execFile(
    file: string,
    args: string[],
    done: (error: unknown, stdout: string, stderr: string) => void,
  ): void;
}>("node:child_process");

const hasNative =
  typeof (Uint8Array.prototype as { toBase64?: unknown }).toBase64 ===
    "function" &&
  typeof (Uint8Array as { fromBase64?: unknown }).fromBase64 === "function";

/** Runs `body` with the native methods removed, then puts them back. */
async function withoutNative<T>(body: () => Promise<T>): Promise<T> {
  const proto = Uint8Array.prototype as { toBase64?: unknown };
  const ctor = Uint8Array as { fromBase64?: unknown };
  const saved = { encode: proto.toBase64, decode: ctor.fromBase64 };
  delete proto.toBase64;
  delete ctor.fromBase64;
  try {
    return await body();
  } finally {
    if (saved.encode !== undefined) proto.toBase64 = saved.encode;
    if (saved.decode !== undefined) ctor.fromBase64 = saved.decode;
  }
}

describe("base64 for snapshots", () => {
  it("chooses the native methods exactly when the runtime has both", () => {
    expect(base64.toBase64 === base64.encodeBinary).toBe(!hasNative);
    expect(base64.fromBase64 === base64.decodeBinary).toBe(!hasNative);
  });

  it("agrees with the fallback on every case, in this runtime", () => {
    expect(mismatches(base64)).toEqual([]);
    expect(snapshotMismatches(codec, base64)).toEqual([]);
  });

  it("falls back to btoa/atob when the native methods are missing at load", async () => {
    const forced = await withoutNative(async () => {
      vi.resetModules();
      return {
        base64: (await import("../src/base64")) as Base64Module,
        codec: await import("../src/snapshot"),
      };
    });
    expect(forced.base64.toBase64).toBe(forced.base64.encodeBinary);
    expect(forced.base64.fromBase64).toBe(forced.base64.decodeBinary);
    expect(mismatches(forced.base64)).toEqual([]);
    expect(snapshotMismatches(forced.codec, forced.base64)).toEqual([]);
    // Byte-identical to this runtime's own choice.
    const snapshot = snapshotCase();
    expect(forced.codec.encodeSnapshot(snapshot)).toEqual(
      codec.encodeSnapshot(snapshot),
    );
  });

  it("chooses, and agrees with the fallback, in a runtime with the native methods (Bun)", async () => {
    // Paths, not file: URLs: Bun gives a path with a query a module
    // instance of its own, and a file: URL with one the cached instance.
    const url = (path: string) =>
      fileURLToPath(new URL(path, import.meta.url).href);
    const script = `
      const base64 = await import(${JSON.stringify(url("../src/base64.ts"))});
      const codec = await import(${JSON.stringify(url("../src/snapshot.ts"))});
      const cases = await import(${JSON.stringify(url("./base64-cases.ts"))});
      const proto = Uint8Array.prototype;
      const saved = [proto.toBase64, Uint8Array.fromBase64];
      delete proto.toBase64;
      delete Uint8Array.fromBase64;
      const forced = await import(${JSON.stringify(`${url("../src/base64.ts")}?forced`)});
      [proto.toBase64, Uint8Array.fromBase64] = saved;
      process.stdout.write(JSON.stringify({
        hasNative: typeof saved[0] === "function" && typeof saved[1] === "function",
        native: base64.toBase64 !== base64.encodeBinary && base64.fromBase64 !== base64.decodeBinary,
        forced: forced.toBase64 === forced.encodeBinary && forced.fromBase64 === forced.decodeBinary,
        mismatches: cases.mismatches(base64),
        snapshot: cases.snapshotMismatches(codec, base64),
      }));`;
    const output = await new Promise<string>((resolve, reject) =>
      execFile("bun", ["-e", script], (error, stdout, stderr) =>
        error
          ? reject(new Error(`${String(error)}\n${stderr}`))
          : resolve(stdout),
      ),
    );
    expect(JSON.parse(output)).toEqual({
      hasNative: true,
      native: true,
      forced: true,
      mismatches: [],
      snapshot: [],
    });
  });
});
