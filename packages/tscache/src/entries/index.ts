// '.' entry — public client API (docs/architecture.md §2.1).

/**
 * The client API: `createClient`, the cache handle, snapshots, errors and
 * the public types.
 *
 * @module @anishbenji/tscache
 */

export type { CacheHandle } from "../client/cache";
export type { TscacheClient } from "../client/client";
export { createClient } from "../client/client";

export type { PutErrorCode } from "../errors";
export {
  AUTH_INVALID_CODE,
  AuthInvalidError,
  ConfigError,
  InvalidRangeError,
  isAuthInvalidError,
  ProtocolMismatchError,
  PutError,
  TscacheError,
  UnknownCacheError,
} from "../errors";
export { decodeSnapshot, encodeSnapshot } from "../snapshot";
export type {
  CacheConfig,
  CalendarInterval,
  CalendarSegmentPayload,
  CalendarSnapshot,
  ClientEvents,
  ClientOptions,
  DenseSegmentPayload,
  Dtype,
  EncodedSegmentPayload,
  EncodedSnapshot,
  FieldArray,
  FixedSegmentPayload,
  FixedSnapshot,
  GetOptions,
  GetResult,
  HostingMode,
  HydrateResult,
  MemoryStats,
  MergeWarning,
  Miss,
  MissReason,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  RequestId,
  ResolvedCalendarInterval,
  Snapshot,
  WorkerFeature,
} from "../types";
export { DTYPES } from "../types";
