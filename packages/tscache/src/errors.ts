/**
 * Error taxonomy — programmer errors reject; data-availability never does
 * (docs/architecture.md §2.6). This module must stay import-free: the
 * './fetcher' entry re-exports from it into worker-side fetcher bundles.
 */

export class TscacheError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid CacheConfig, or cache() config conflict across tabs (N4). */
export class ConfigError extends TscacheError {}

/** NaN/inverted range endpoints. Unaligned endpoints snap, not reject (N1). */
export class InvalidRangeError extends TscacheError {}

export class UnknownCacheError extends TscacheError {}

export type PutErrorCode =
  | "misaligned"
  | "unsorted"
  | "duplicate"
  | "field-mismatch"
  | "length-mismatch"
  /** options.range does not contain every batch timestamp. */
  | "range-mismatch";

/** Atomic batch reject, naming the first offender. */
export class PutError extends TscacheError {
  readonly code: PutErrorCode;
  readonly offenderIndex: number;
  readonly offenderTimestamp?: number;
  /** Human-readable expectation, e.g. "t ≡ 0 (mod 60000)". */
  readonly expected?: string;

  constructor(
    message: string,
    opts: {
      code: PutErrorCode;
      offenderIndex: number;
      offenderTimestamp?: number;
      expected?: string;
    },
  ) {
    super(message);
    this.code = opts.code;
    this.offenderIndex = opts.offenderIndex;
    if (opts.offenderTimestamp !== undefined)
      this.offenderTimestamp = opts.offenderTimestamp;
    if (opts.expected !== undefined) this.expected = opts.expected;
  }
}

/** Handshake refusal: package skew or stale cached worker script. */
export class ProtocolMismatchError extends TscacheError {
  readonly clientProtocol: number;
  readonly workerProtocol: number;

  constructor(
    message: string,
    opts: { clientProtocol: number; workerProtocol: number },
  ) {
    super(message);
    this.clientProtocol = opts.clientProtocol;
    this.workerProtocol = opts.workerProtocol;
  }
}

/** Marker for cross-bundle auth-failure detection (N6/N8). */
export const AUTH_INVALID_CODE = "tscache:auth-invalid";

/**
 * Distinguished auth-failure signal — fetchers THROW this from fetch() (N8).
 * Detection is marker-based, never instanceof: the fetcher module is a
 * separate bundle and may carry its own copy of the class.
 */
export class AuthInvalidError extends TscacheError {
  readonly code: string = AUTH_INVALID_CODE;
}

/** Cross-bundle-safe check used by the orchestrator on fetcher throws. */
export function isAuthInvalidError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { code?: unknown }).code === AUTH_INVALID_CODE
  );
}
