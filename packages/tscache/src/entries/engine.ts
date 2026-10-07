// './engine' entry — in-process Engine for SSR/Node and tests. No DOM/worker
// imports may ever reach this graph (docs/architecture.md §2.1, §4.6).

export type { EngineEvents } from "../engine/engine";
export { Engine } from "../engine/engine";
export type { PutErrorCode } from "../errors";
export {
  ConfigError,
  InvalidRangeError,
  PutError,
  TscacheError,
  UnknownCacheError,
} from "../errors";
export type {
  CacheConfig,
  Dtype,
  FieldArray,
  GetResult,
  MergeWarning,
  Miss,
  MissReason,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  ResolvedCacheConfig,
} from "../types";
export { DTYPES } from "../types";
