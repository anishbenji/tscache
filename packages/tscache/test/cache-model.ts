import type { Dtype, Range } from "../src/types";

// An independent, slot-by-slot model of one cache, written from architecture
// §2.3–§2.4, §4.3–§4.5 and decisions N1, N3, N11, N13–N19. It uses no
// production helper: snapping scans the grid, coverage is a set of slots,
// stored points are a map from slot to values, and the segment layout is
// recomputed from the present slots. Shared by the seeded property tests in
// cache-model-property.test.ts and cache-faults-property.test.ts.

type Storage = new (values: number[]) => ArrayLike<number>;

const STORAGE: Readonly<Record<Dtype, Storage>> = {
  f64: Float64Array,
  f32: Float32Array,
  i32: Int32Array,
  u32: Uint32Array,
  i16: Int16Array,
  u16: Uint16Array,
  i8: Int8Array,
  u8: Uint8Array,
};

/** The storage class of a dtype (N7), for checking what `get` returns. */
export function storageOf(dtype: Dtype): Storage {
  return STORAGE[dtype];
}

/** A value as stored in a field of `dtype`: typed-array assignment (§4.3). */
export function stored(dtype: Dtype, value: number): number {
  return new STORAGE[dtype]([value])[0] as number;
}

/** Equal for the overlap warning (§4.3): `a === b`, or both NaN. */
function same(a: number, b: number): boolean {
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** Small seeded generator (mulberry32): no dependency or global random state. */
export function rng(seed: number): {
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
} {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const int = (min: number, max: number): number =>
    min + Math.floor(next() * (max - min + 1));
  return {
    int,
    pick: <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T,
  };
}

export interface ModelConfig {
  interval: number;
  offset: number;
  /** gapSplitK */
  k: number;
  /** segmentSlotCap */
  cap: number;
  /** The slots operations draw from; snapping scans a margin around them. */
  lo: number;
  hi: number;
  warn: boolean;
  fields: Record<string, Dtype>;
  finalizedUntil?: number;
  version?: string;
}

export interface ModelMeta {
  version?: string;
  finalizedUntil?: number;
}

export interface ModelWarning {
  range: Range;
  fields: string[];
}

export interface Extent {
  start: number;
  end: number;
  size: number;
}

/** Inclusive slot span, in slot terms. */
export interface Span {
  start: number;
  end: number;
}

/** How far around [lo, hi] the scans for snapping reach. */
const MARGIN = 64;

export class CacheModel {
  readonly rows: Map<number, number[]> = new Map();
  readonly covered: Set<number> = new Set();
  watermark: number | undefined;
  version: string | undefined;
  readonly names: string[];

  /**
   * `note` hears which rule each operation exercised, so a test can show its
   * generator reached every rule it claims to check.
   */
  constructor(
    readonly config: ModelConfig,
    readonly note: (event: string) => void = () => {},
  ) {
    this.watermark = config.finalizedUntil;
    this.version = config.version;
    this.names = Object.keys(config.fields);
  }

  ms(slot: number): number {
    return this.config.offset + this.config.interval * slot;
  }

  /** First slot whose timestamp is at or after t; +Infinity past the scan. */
  slotAtOrAfter(t: number): number {
    for (let s = this.config.lo - MARGIN; s <= this.config.hi + MARGIN; s++) {
      if (this.ms(s) >= t) return s;
    }
    return Number.POSITIVE_INFINITY;
  }

  /** First provisional slot (§2.4); +Infinity when nothing is provisional. */
  volatileFrom(): number {
    return this.watermark === undefined
      ? Number.POSITIVE_INFINITY
      : this.slotAtOrAfter(this.watermark);
  }

  /** The grid points inside r: a put range snapped inward (N13). */
  inward(r: Range): number[] {
    const out: number[] = [];
    for (let s = this.config.lo - MARGIN; s <= this.config.hi + MARGIN; s++) {
      if (r.start <= this.ms(s) && this.ms(s) <= r.end) out.push(s);
    }
    return out;
  }

  /** A get or invalidate range snapped outward (N1). */
  outward(r: Range): Span {
    let start = Number.NaN;
    let end = Number.NaN;
    for (let s = this.config.lo - MARGIN; s <= this.config.hi + MARGIN; s++) {
      if (this.ms(s) <= r.start) start = s;
    }
    for (let s = this.config.hi + MARGIN; s >= this.config.lo - MARGIN; s--) {
      if (this.ms(s) >= r.end) end = s;
    }
    return { start, end };
  }

  /** The put's authority (N13): undefined without a range or grid point. */
  authority(range: Range | undefined): Span | undefined {
    if (range === undefined) return undefined;
    const inside = this.inward(range);
    if (inside.length === 0) return undefined;
    return { start: inside[0] as number, end: inside.at(-1) as number };
  }

  /** What a put touches: its authority, or without one its batch's span (N3). */
  touched(
    slots: readonly number[],
    range: Range | undefined,
  ): Span | undefined {
    const authority = this.authority(range);
    if (authority !== undefined) return authority;
    if (slots.length === 0) return undefined;
    return { start: slots[0] as number, end: slots.at(-1) as number };
  }

  /**
   * The version step of a put (§4.5, N18): a differing version clears a
   * versioned cache and is adopted; an unversioned cache adopts the first
   * version without clearing. Returns whether it cleared.
   */
  applyVersion(version: string | undefined): boolean {
    if (version === undefined || version === this.version) return false;
    const cleared = this.version !== undefined;
    if (cleared) this.clear();
    this.note(
      cleared ? "N18 version mismatch cleared" : "N18 first version adopted",
    );
    this.version = version;
    return cleared;
  }

  /** The rest of a put, after the version step (§4.3, §4.5, N11, N17, N19). */
  write(
    slots: readonly number[],
    columns: readonly (readonly number[])[],
    range: Range | undefined,
    finalizedUntil: number | undefined,
  ): ModelWarning[] {
    const authority = this.authority(range);
    const touched = this.touched(slots, range);
    const own =
      finalizedUntil === undefined
        ? Number.POSITIVE_INFINITY
        : this.slotAtOrAfter(finalizedUntil);
    const values = slots.map((_, i) =>
      this.names.map((name, c) =>
        stored(
          this.config.fields[name] as Dtype,
          (columns[c] as readonly number[])[i] as number,
        ),
      ),
    );
    // Overlap warnings, judged against the points stored before this put.
    const runs: { start: number; end: number; fields: Set<string> }[] = [];
    if (this.config.warn) {
      let run: (typeof runs)[number] | undefined;
      slots.forEach((slot, i) => {
        const old = this.rows.get(slot);
        const differ = new Set<string>();
        if (old !== undefined) {
          this.names.forEach((name, c) => {
            const now = (values[i] as number[])[c] as number;
            if (!same(old[c] as number, now)) differ.add(name);
          });
        }
        if (differ.size === 0) {
          run = undefined;
        } else if (run === undefined) {
          run = { start: slot, end: slot, fields: differ };
          runs.push(run);
        } else {
          run.end = slot;
          for (const name of differ) run.fields.add(name);
        }
      });
    }
    // Replace inside the authority (N11), only below the put's own watermark (N19).
    if (authority !== undefined) {
      for (const slot of [...this.rows.keys()]) {
        if (authority.start <= slot && slot <= authority.end) {
          if (slot < own) this.rows.delete(slot);
          else if (!slots.includes(slot))
            this.note("N19 provisional point kept");
        }
      }
    }
    // New values win.
    slots.forEach((slot, i) => {
      this.rows.set(slot, values[i] as number[]);
    });
    // The watermark only advances (N17).
    if (finalizedUntil !== undefined) {
      if (this.watermark === undefined || finalizedUntil > this.watermark) {
        this.watermark = finalizedUntil;
        this.#uncoverFrom(this.volatileFrom());
        this.note("N17 watermark advanced");
      } else {
        this.note("N17 lower watermark ignored");
      }
    }
    // Coverage: the claim below the put's own watermark (N19) and below the
    // volatile region as it now stands (§4.5).
    const from = this.volatileFrom();
    if (touched !== undefined) {
      for (let s = touched.start; s <= touched.end; s++) {
        if (s < own && s < from) this.covered.add(s);
        else if (s >= own) this.note("N19 claim clipped");
        else this.note("volatile slot left uncovered");
      }
    }
    // Warnings outside the volatile region, judged after the advance.
    const warnings: ModelWarning[] = [];
    for (const w of runs) {
      if (w.start >= from) {
        this.note("warning in the volatile region dropped");
        continue;
      }
      if (w.end >= from) this.note("warning clipped at the volatile region");
      else this.note("warning reported");
      warnings.push({
        range: {
          start: this.ms(w.start),
          end: this.ms(Math.min(w.end, from - 1)),
        },
        fields: this.names.filter((name) => w.fields.has(name)),
      });
    }
    return warnings;
  }

  put(
    slots: readonly number[],
    columns: readonly (readonly number[])[],
    range: Range | undefined,
    meta: ModelMeta | undefined,
  ): { warnings: ModelWarning[]; cleared: boolean } {
    const cleared = this.applyVersion(meta?.version);
    const warnings = this.write(slots, columns, range, meta?.finalizedUntil);
    return { warnings, cleared };
  }

  invalidate(range: Range): void {
    const { start, end } = this.outward(range);
    for (const slot of [...this.covered]) {
      if (start <= slot && slot <= end) this.covered.delete(slot);
    }
  }

  /** Sets the watermark exactly; slots at or after it are provisional again. */
  setFinalizedUntil(t: number): void {
    this.watermark = t;
    this.#uncoverFrom(this.volatileFrom());
  }

  /** Drops points and coverage; keeps version and watermark (§4.5). */
  clear(): void {
    this.rows.clear();
    this.covered.clear();
  }

  #uncoverFrom(from: number): void {
    for (const slot of [...this.covered]) {
      if (slot >= from) this.covered.delete(slot);
    }
  }

  /** Every present point in the request, its coverage and its misses (N16). */
  get(range: Range): {
    timestamps: number[];
    fields: number[][];
    coverage: Range[];
    misses: Range[];
  } {
    const { start, end } = this.outward(range);
    const timestamps: number[] = [];
    const fields: number[][] = this.names.map(() => []);
    for (let s = start; s <= end; s++) {
      const row = this.rows.get(s);
      if (row === undefined) continue;
      timestamps.push(this.ms(s));
      row.forEach((v, c) => {
        (fields[c] as number[]).push(v);
      });
    }
    return {
      timestamps,
      fields,
      coverage: this.#runs(start, end, true),
      misses: this.#runs(start, end, false),
    };
  }

  #runs(start: number, end: number, covered: boolean): Range[] {
    const out: Range[] = [];
    let run: Range | undefined;
    for (let s = start; s <= end; s++) {
      if (this.covered.has(s) !== covered) {
        run = undefined;
      } else if (run === undefined) {
        run = { start: this.ms(s), end: this.ms(s) };
        out.push(run);
      } else {
        run.end = this.ms(s);
      }
    }
    return out;
  }

  coveredSlots(): number[] {
    return [...this.covered].sort((a, b) => a - b);
  }

  presentSlots(): number[] {
    return [...this.rows.keys()].sort((a, b) => a - b);
  }

  /** The segment layout the present points must have (N14, N15). */
  layout(): Extent[] {
    return layoutOf(this.presentSlots(), this.config.k, this.config.cap);
  }
}

/**
 * The layout of present slots (N14, N15): two neighbouring points share a
 * segment exactly when they are on the same page (floor(slot / cap)) and at
 * most K slots between them hold no point.
 */
function layoutOf(slots: readonly number[], k: number, cap: number): Extent[] {
  const out: Extent[] = [];
  let prev: number | undefined;
  for (const s of slots) {
    const last = out.at(-1);
    if (
      last !== undefined &&
      prev !== undefined &&
      Math.floor(prev / cap) === Math.floor(s / cap) &&
      s - prev - 1 <= k
    ) {
      last.end = s;
      last.size += 1;
    } else {
      out.push({ start: s, end: s, size: 1 });
    }
    prev = s;
  }
  return out;
}
