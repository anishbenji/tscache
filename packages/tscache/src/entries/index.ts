// '.' entry — public client API (docs/architecture.md §2.1).

/**
 * The client API: `createClient`, the cache handle, snapshots, errors and
 * the public types.
 *
 * @module tscache
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
  ClientEvents,
  ClientOptions,
  DenseSegmentPayload,
  Dtype,
  EncodedSegmentPayload,
  EncodedSnapshot,
  FieldArray,
  GetOptions,
  GetResult,
  HostingMode,
  HydrateResult,
  MergeWarning,
  Miss,
  MissReason,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  RequestId,
  Snapshot,
} from "../types";
export { DTYPES } from "../types";
