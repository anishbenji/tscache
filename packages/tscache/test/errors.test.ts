import { describe, expect, it } from "vitest";
import {
  AUTH_INVALID_CODE,
  AuthInvalidError,
  ConfigError,
  InvalidRangeError,
  isAuthInvalidError,
  ProtocolMismatchError,
  PutError,
  TscacheError,
  UnknownCacheError,
} from "../src/errors";

describe("error taxonomy", () => {
  it("all classes extend TscacheError and Error", () => {
    const errors = [
      new ConfigError("x"),
      new InvalidRangeError("x"),
      new UnknownCacheError("x"),
      new PutError("x", { code: "misaligned", offenderIndex: 0 }),
      new ProtocolMismatchError("x", { clientProtocol: 1, workerProtocol: 2 }),
      new AuthInvalidError("x"),
    ];
    for (const e of errors) {
      expect(e).toBeInstanceOf(TscacheError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("sets name to the class name for wire serialization", () => {
    expect(new ConfigError("x").name).toBe("ConfigError");
    expect(new PutError("x", { code: "unsorted", offenderIndex: 3 }).name).toBe(
      "PutError",
    );
    expect(new AuthInvalidError("x").name).toBe("AuthInvalidError");
  });

  it("PutError carries structured offender detail", () => {
    const e = new PutError("misaligned timestamp", {
      code: "misaligned",
      offenderIndex: 7,
      offenderTimestamp: 1_700_000_123,
      expected: "t ≡ 0 (mod 60000)",
    });
    expect(e.code).toBe("misaligned");
    expect(e.offenderIndex).toBe(7);
    expect(e.offenderTimestamp).toBe(1_700_000_123);
    expect(e.expected).toBe("t ≡ 0 (mod 60000)");
  });

  it("ProtocolMismatchError carries both protocol versions", () => {
    const e = new ProtocolMismatchError("skew", {
      clientProtocol: 1,
      workerProtocol: 2,
    });
    expect(e.clientProtocol).toBe(1);
    expect(e.workerProtocol).toBe(2);
  });
});

describe("auth-invalid marker detection (cross-bundle safe)", () => {
  it("AuthInvalidError instances carry the marker code", () => {
    expect(new AuthInvalidError("401").code).toBe(AUTH_INVALID_CODE);
    expect(AUTH_INVALID_CODE).toBe("tscache:auth-invalid");
  });

  it("detects by marker, not instanceof — duplicate-class copies still match", () => {
    // Simulates a fetcher bundle shipping its own copy of the class.
    class ForeignAuthError extends Error {
      readonly code = AUTH_INVALID_CODE;
    }
    expect(isAuthInvalidError(new AuthInvalidError("401"))).toBe(true);
    expect(isAuthInvalidError(new ForeignAuthError())).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isAuthInvalidError(new Error("401"))).toBe(false);
    expect(isAuthInvalidError(new ConfigError("x"))).toBe(false);
    expect(isAuthInvalidError({ code: "other" })).toBe(false);
    expect(isAuthInvalidError(null)).toBe(false);
    expect(isAuthInvalidError(undefined)).toBe(false);
    expect(isAuthInvalidError("tscache:auth-invalid")).toBe(false);
  });
});
