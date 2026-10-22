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
export { decodeSnapshot, encodeSnapshot } from "../snapshot";
export type {
  CacheConfig,
  DenseSegmentPayload,
  Dtype,
  EncodedSegmentPayload,
  EncodedSnapshot,
  FieldArray,
  GetResult,
  HydrateResult,
  MergeWarning,
  Miss,
  MissReason,
  PutBatch,
  PutOptions,
  PutResult,
  Range,
  ResolvedCacheConfig,
  Snapshot,
} from "../types";
export { DTYPES } from "../types";
