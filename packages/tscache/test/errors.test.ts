import { describe, expect, expectTypeOf, it } from "vitest";
import { HostingError } from "../src/client/hosting";
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

  // A minifier renames class identifiers, and with them each constructor's
  // `name` (review 2026-11, L2: names arrived as `r`, `b`, `e` under
  // Next.js). Redefining `name` on the constructor simulates that without a
  // bundler; the documented name (architecture §2.6) must not move with it.
  const classes: [string, { readonly name: string }, () => Error][] = [
    ["TscacheError", TscacheError, () => new TscacheError("x")],
    ["ConfigError", ConfigError, () => new ConfigError("x")],
    ["InvalidRangeError", InvalidRangeError, () => new InvalidRangeError("x")],
    ["UnknownCacheError", UnknownCacheError, () => new UnknownCacheError("x")],
    [
      "PutError",
      PutError,
      () => new PutError("x", { code: "misaligned", offenderIndex: 0 }),
    ],
    [
      "ProtocolMismatchError",
      ProtocolMismatchError,
      () =>
        new ProtocolMismatchError("x", {
          clientProtocol: 1,
          workerProtocol: 2,
        }),
    ],
    ["AuthInvalidError", AuthInvalidError, () => new AuthInvalidError("x")],
    // Not exported, but createClient rejects with it at the end of the
    // fallback chain, so its name is how an application recognises it.
    ["HostingError", HostingError, () => new HostingError("x")],
  ];

  it.each(classes)(
    "%s keeps its documented name when a minifier renames the class",
    (documented, cls, make) => {
      const own = Object.getOwnPropertyDescriptor(cls, "name");
      Object.defineProperty(cls, "name", { value: "r", configurable: true });
      try {
        expect(cls.name).toBe("r");
        expect(make().name).toBe(documented);
      } finally {
        if (own) Object.defineProperty(cls, "name", own);
      }
    },
  );

  it("a subclass outside the library is named by its own constructor", () => {
    class AppConfigError extends ConfigError {}
    class AppPutError extends PutError {}
    expect(new AppConfigError("x").name).toBe("AppConfigError");
    expect(
      new AppPutError("x", { code: "unsorted", offenderIndex: 0 }).name,
    ).toBe("AppPutError");
    expect(new AppConfigError("x")).toBeInstanceOf(ConfigError);
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

  it("types the marker as the literal from architecture §2.6", () => {
    expectTypeOf(
      new AuthInvalidError("401").code,
    ).toEqualTypeOf<"tscache:auth-invalid">();
    expectTypeOf(AUTH_INVALID_CODE).toEqualTypeOf<"tscache:auth-invalid">();
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
