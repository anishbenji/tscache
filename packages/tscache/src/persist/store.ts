/**
 * The persistence store seam (docs/architecture.md §4.10.3, N60): the one
 * narrow interface through which persistence reaches IndexedDB. The
 * persister is tested against an in-memory implementation; the IndexedDB
 * adapter (`idb-store.ts`) is held to the same contract.
 */

import type { CacheRecord, PageRecord } from "./records";

/** Inclusive range of page indices; ±Infinity allowed. */
export interface PageRange {
  start: number;
  end: number;
}

/** The stored records of one cache. */
export interface StoredCache {
  cache: CacheRecord | undefined;
  /** Ascending by page. */
  pages: PageRecord[];
}

/** One atomic write: deletions, then page puts, then the cache record. */
export interface WritePlan {
  /** Every page record of the cache whose page lies in one of these ranges goes. */
  deletePages: PageRange[];
  /** Each replaces the record under its key; every cacheId is the write's. */
  putPages: PageRecord[];
  /** The cache record to put, or null to delete it. */
  putCache: CacheRecord | null;
  /** Strict durability: set when the plan carries a removal (N49, N58). */
  strict: boolean;
}

export interface PersistStore {
  /** One read-only transaction: the cache record and its page records, all of them or those in `pages`. */
  read(cacheId: string, pages?: PageRange[]): Promise<StoredCache>;
  /**
   * One read-write transaction, with strict durability when `plan.strict`
   * and relaxed otherwise (N49): all of the plan or none of it. Resolves when
   * the transaction completed. Rejects with the transaction's error, whose
   * `name` is 'QuotaExceededError' when the origin's quota is exceeded.
   */
  write(cacheId: string, plan: WritePlan): Promise<void>;
  /** One read-write transaction with strict durability: every record of every cache goes. */
  clearAll(): Promise<void>;
  /** Releases the connection; every later call rejects with an error named 'InvalidStateError'. */
  close(): void;
}
