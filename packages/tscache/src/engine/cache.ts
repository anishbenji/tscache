/**
 * One cache's state (docs/architecture.md §4.5): its resolved config, the
 * segments, the coverage index, the finalized watermark and the dataset
 * version. Speaks milliseconds to its callers and slots to the modules
 * beneath; every conversion goes through grid.ts.
 */

import { CoverageIndex } from "../coverage";
import { ConfigError, InvalidRangeError, PutError, show } from "../errors";
import { type SlotRange, slotAtOrAfter, snapOut, toMs } from "../grid";
import type { Columns } from "../segment/types";
import type {
  GetResult,
  MergeWarning,
  PutBatch,
  PutOptions,
  Range,
  ResolvedCacheConfig,
} from "../types";
import { validateBatch } from "./batch";
import { SegmentStore } from "./merge";
import type { SlotWarning } from "./overlap";
import { read } from "./read";

export interface CachePutResult {
  /** In ms, outside the volatile region only. */
  warnings: MergeWarning[];
  /** True when a version mismatch cleared the cache before this put. */
  cleared: boolean;
}

/** Validated `PutBatch.meta`: the watermark comes with its slot. */
interface Meta {
  version?: string;
  finalizedUntil?: { t: number; slot: number };
}

/** Structural rejects of a batch have no offending timestamp. */
function reject(message: string): never {
  throw new PutError(message, { code: "field-mismatch", offenderIndex: -1 });
}

function validVersion(version: unknown): string {
  if (typeof version !== "string" || version.length === 0) {
    reject(`meta.version must be a non-empty string, got ${show(version)}`);
  }
  return version;
}

/** The tight slot range of validated points, or undefined when empty. */
function spanOf(points: Columns): SlotRange | undefined {
  const n = points.slots.length;
  if (n === 0) return undefined;
  return {
    start: points.slots[0] as number,
    end: points.slots[n - 1] as number,
  };
}

export class CacheState {
  readonly config: ResolvedCacheConfig;
  readonly #store: SegmentStore;
  readonly #coverage = new CoverageIndex();
  #version: string | undefined;
  #finalizedUntil: number | undefined;
  /** First provisional slot; undefined when nothing is provisional. */
  #volatileFrom: number | undefined;

  constructor(config: ResolvedCacheConfig) {
    this.config = config;
    this.#store = new SegmentStore(config);
    this.#version = config.version;
    if (config.finalizedUntil !== undefined) {
      try {
        this.#volatileFrom = slotAtOrAfter(config.finalizedUntil, config);
      } catch (error) {
        if (!(error instanceof InvalidRangeError)) throw error;
        throw new ConfigError(`finalizedUntil: ${error.message}`);
      }
      this.#finalizedUntil = config.finalizedUntil;
    }
  }

  /** The dataset version in force: config.version, then whatever puts report. */
  get version(): string | undefined {
    return this.#version;
  }

  /** Points at t >= finalizedUntil are provisional; undefined: nothing is. */
  get finalizedUntil(): number | undefined {
    return this.#finalizedUntil;
  }

  /**
   * Validate → version check and clear → write → advance the watermark →
   * record coverage (§4.5). A rejected batch changes nothing; a write that
   * fails part-way withdraws the coverage it would have recorded.
   */
  put(batch: PutBatch, options?: PutOptions): CachePutResult {
    const { points, authority } = validateBatch(
      batch,
      this.config,
      options?.range,
    );
    const meta = this.#validateMeta(batch.meta);
    const cleared = this.#applyVersion(meta.version);
    const claim = authority ?? spanOf(points);
    let slotWarnings: SlotWarning[];
    try {
      slotWarnings = this.#store.put(points, authority);
    } catch (error) {
      if (claim !== undefined) this.#coverage.subtract(claim);
      throw error;
    }
    const wm = meta.finalizedUntil;
    if (
      wm !== undefined &&
      (this.#finalizedUntil === undefined || wm.t > this.#finalizedUntil)
    ) {
      this.#setWatermark(wm.t, wm.slot);
    }
    if (claim !== undefined) this.#cover(claim);
    return { warnings: this.#toWarnings(slotWarnings), cleared };
  }

  /** Every present point in the range, with coverage and 'uncached' misses. */
  get(range: Range): GetResult {
    const request = snapOut(range, this.config);
    return read(
      request,
      this.#store.segments,
      this.#coverage,
      this.config,
      this.config.fields,
    );
  }

  /** Forgets coverage; the points stay (N16). Snaps outward (N1). */
  invalidate(range: Range): void {
    this.#coverage.subtract(snapOut(range, this.config));
  }

  /** Drops segments and coverage; config, version and watermark stay. */
  clear(): void {
    this.#store.clear();
    this.#coverage.clear();
  }

  /** Sets the watermark exactly; moving it back makes points provisional again. */
  setFinalizedUntil(t: number): void {
    this.#setWatermark(t, slotAtOrAfter(t, this.config));
  }

  #setWatermark(t: number, slot: number): void {
    // Nothing was provisional before, or the region grew: forget its coverage.
    if (this.#volatileFrom === undefined || slot < this.#volatileFrom) {
      this.#coverage.subtract({ start: slot, end: Number.MAX_SAFE_INTEGER });
    }
    this.#finalizedUntil = t;
    this.#volatileFrom = slot;
  }

  /** Records a claim as authoritative, minus the volatile region. */
  #cover(claim: SlotRange): void {
    const end =
      this.#volatileFrom === undefined
        ? claim.end
        : Math.min(claim.end, this.#volatileFrom - 1);
    if (claim.start <= end) this.#coverage.add({ start: claim.start, end });
  }

  /** A differing version clears the cache; the first one seen is adopted (N18). */
  #applyVersion(version: string | undefined): boolean {
    if (version === undefined) return false;
    const cleared = this.#version !== undefined && version !== this.#version;
    if (cleared) this.clear();
    this.#version = version;
    return cleared;
  }

  #validateMeta(meta: PutBatch["meta"]): Meta {
    if (meta === undefined) return {};
    if (typeof meta !== "object" || meta === null) {
      reject(`meta must be an object, got ${show(meta)}`);
    }
    const out: Meta = {};
    if (meta.version !== undefined) out.version = validVersion(meta.version);
    if (meta.finalizedUntil !== undefined) {
      out.finalizedUntil = this.#validWatermark(meta.finalizedUntil);
    }
    return out;
  }

  #validWatermark(t: number): { t: number; slot: number } {
    try {
      return { t, slot: slotAtOrAfter(t, this.config) };
    } catch (error) {
      if (!(error instanceof InvalidRangeError)) throw error;
      return reject(`meta.finalizedUntil: ${error.message}`);
    }
  }

  /** Slot warnings → ms, dropping the volatile region (§2.4). */
  #toWarnings(warnings: SlotWarning[]): MergeWarning[] {
    const out: MergeWarning[] = [];
    const from = this.#volatileFrom;
    for (const { range, fields } of warnings) {
      if (from !== undefined && range.start >= from) continue;
      const end =
        from === undefined ? range.end : Math.min(range.end, from - 1);
      out.push({
        range: toMs({ start: range.start, end }, this.config),
        fields,
      });
    }
    return out;
  }
}
