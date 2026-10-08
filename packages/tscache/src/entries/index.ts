// '.' entry — public client API (docs/architecture.md §2.1).

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
export type {
  CacheConfig,
  ClientEvents,
  ClientOptions,
  Dtype,
  FieldArray,
  GetOptions,
  GetResult,
  HostingMode,
  MergeWarning,
  Miss,
  MissReason,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  RequestId,
} from "../types";
export { DTYPES } from "../types";
