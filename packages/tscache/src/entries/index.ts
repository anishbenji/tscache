// '.' entry — public client API. createClient lands at steps ⑨–⑩ per
// docs/architecture.md §4.

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
  Dtype,
  FieldArray,
  GetOptions,
  GetResult,
  MergeWarning,
  Miss,
  MissReason,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
} from "../types";
export { DTYPES } from "../types";
