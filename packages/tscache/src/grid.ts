/**
 * ms↔slot conversion — the single fencepost site (docs/architecture.md §4.1,
 * N1, N9, N118). Every other module does range math on integer slot indices,
 * so an off-by-one can only be introduced, and only needs to be reviewed,
 * here.
 *
 * Two kinds of grid, told apart by `calendar`:
 *
 * - A fixed grid, `alignmentOffset + k × interval` in ms. This module does
 *   not validate it: the functions assume `interval` is a positive safe
 *   integer and `alignmentOffset` an integer in [0, interval), which
 *   `resolveCacheConfig` guarantees. What they enforce is the timestamp
 *   domain: an unsupported timestamp is never aligned, and a range or
 *   watermark that is not finite, lies beyond ±(2^53 − 1) or snaps to a grid
 *   point beyond it throws `InvalidRangeError`.
 * - A calendar grid (N106): one slot per calendar unit in a time zone.
 *   `resolveCalendarInterval` validates its descriptor, and the two
 *   primitives (`startOf`, `floorSlot`) enforce its domain, the units whose
 *   first local date lies in the years 1 to 9999 (N117), before any `Intl`
 *   call can meet an instant it rejects.
 */

import { ConfigError, InvalidRangeError, show } from "./errors";
import type { Range, ResolvedCalendarInterval } from "./types";

/** A cache's fixed alignment grid. */
interface FixedGrid {
  /** Positive safe integer (ms). */
  interval: number;
  /** In [0, interval). */
  alignmentOffset: number;
  calendar?: undefined;
}

/** A calendar grid, made by `createCalendarGrid`; shared by every cache of its descriptor. */
export interface CalendarGrid {
  /** The resolved, frozen descriptor. */
  readonly interval: ResolvedCalendarInterval;
  readonly alignmentOffset: 0;
  /** The calendar's arithmetic, zone lookups and tables of slot starts. */
  readonly calendar: Calendar;
}

/** A cache's alignment grid. */
export type Grid = FixedGrid | CalendarGrid;

/** Inclusive on both ends; safe-integer slot indices; slots may be negative. */
export interface SlotRange {
  start: number;
  end: number;
}

const DAY = 86_400_000;
/** Slots per table of slot starts (N124). */
const BLOCK = 512;
/** Tables an engine holds, in one least-recently-used order (N124). */
const TABLE_CAPACITY = 256;
/** Offset lookups one `hydrate` or one load may cause (N113). */
const LOOKUP_BUDGET = 524_288;

const UNITS = ["day", "week", "month", "quarter", "year"] as const;
/** Months per slot of the month-based units. */
const MONTHS: Partial<Record<string, number>> = {
  month: 1,
  quarter: 3,
  year: 12,
};

/** Days from 1970-01-01 to the proleptic Gregorian date `y-m-d` (m from 1). */
function daysFromCivil(y: number, m: number, d: number): number {
  const year = m <= 2 ? y - 1 : y;
  const era = Math.floor(year / 400);
  const yoe = year - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** Months from 1970-01 to the month of day number `day` (the inverse, to the month). */
function monthIndex(day: number): number {
  const z = day + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36_524) -
      Math.floor(doe / 146_096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  // `mp` counts months from March: January and February belong to the next year.
  const year = yoe + era * 400 + (mp < 10 ? 0 : 1);
  return (year - 1970) * 12 + (mp < 10 ? mp + 2 : mp - 10);
}

/** What `createCalendarGridContext` takes: the test seam of §4.1. */
export interface CalendarGridOptions {
  /** The zone's UTC offset in ms at an instant; default: the runtime's `Intl`. */
  offsetAt?: (zone: string, instant: number) => number;
  /** Called for each step `floorSlot` takes from its candidate slot. */
  onFloorStep?: (direction: -1 | 1) => void;
  /** Tables of slot starts held at most; default 256. */
  tableCapacity?: number;
  /** Offset lookups one `hydrate` or one load may cause; default 524,288. */
  lookupBudget?: number;
}

/**
 * What the calendar grids of one engine share (N124): the offset lookup,
 * the tables of slot starts in one least-recently-used order, and the
 * lookup budget of a `hydrate` or a load (N113).
 */
export interface CalendarGridContext {
  /** Tables of slot starts held now. */
  readonly tableCount: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The runtime's formatter of a zone's offset; throws RangeError for an unknown zone. */
function formatterOf(zone: string): Intl.DateTimeFormat {
  let format = formatters.get(zone);
  if (format === undefined) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "longOffset",
    });
    formatters.set(zone, format);
  }
  return format;
}

// The sign may be an ASCII hyphen or U+2212, as the runtime's locale data has it.
const OFFSET = /GMT(?:([+\-\u2212])(\d+)(?::(\d+))?(?::(\d+))?)?$/;

/** The zone's UTC offset in ms at `instant`, from the runtime's zone data (N108). */
function intlOffset(zone: string, instant: number): number {
  // "…, GMT-04:56:02", "…, GMT+05:45" or "…, GMT".
  const match = OFFSET.exec(formatterOf(zone).format(instant));
  if (match === null) throw new RangeError(`no offset for ${zone}`);
  const [, sign = "+", h = "0", m = "0", s = "0"] = match;
  const ms = (+h * 3600 + +m * 60 + +s) * 1000;
  return sign === "+" ? ms : -ms;
}

class Context implements CalendarGridContext {
  readonly offsetAt: (zone: string, instant: number) => number;
  readonly onFloorStep: ((direction: -1 | 1) => void) | undefined;
  readonly lookupBudget: number;
  readonly #capacity: number;
  /** One grid per resolved descriptor. */
  readonly grids: Map<string, CalendarGrid> = new Map();
  /** Every table held, least recently used first, with its owner and block. */
  readonly #order = new Map<Float64Array, { owner: Calendar; block: number }>();

  constructor(options: CalendarGridOptions) {
    this.offsetAt = options.offsetAt ?? intlOffset;
    this.onFloorStep = options.onFloorStep;
    this.lookupBudget = options.lookupBudget ?? LOOKUP_BUDGET;
    this.#capacity = options.tableCapacity ?? TABLE_CAPACITY;
  }

  get tableCount(): number {
    return this.#order.size;
  }

  /** Marks a held table as the most recently used. */
  touch(table: Float64Array): void {
    const entry = this.#order.get(table);
    if (entry === undefined) return;
    this.#order.delete(table);
    this.#order.set(table, entry);
  }

  /** Holds a new table, dropping the least recently used ones above the capacity. */
  hold(table: Float64Array, owner: Calendar, block: number): void {
    this.#order.set(table, { owner, block });
    while (this.#order.size > this.#capacity) {
      const [oldest, entry] = this.#order.entries().next().value as [
        Float64Array,
        { owner: Calendar; block: number },
      ];
      this.#order.delete(oldest);
      entry.owner.drop(entry.block);
    }
  }
}

/**
 * A context for calendar grids. An engine makes its own; `options` is the
 * seam the contract tests inject zone rules and limits through.
 */
export function createCalendarGridContext(
  options: CalendarGridOptions = {},
): CalendarGridContext {
  return new Context(options);
}

let defaultContext: Context | undefined;

function failConfig(message: string): never {
  throw new ConfigError(message);
}

type Unit = ResolvedCalendarInterval["unit"];
type WeekDay = NonNullable<ResolvedCalendarInterval["weekStart"]>;
const WEEK_DAYS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

function validUnit(unit: unknown): Unit {
  if (!UNITS.includes(unit as Unit)) {
    failConfig(
      `interval.unit must be one of ${UNITS.join(", ")}, got ${show(unit)}`,
    );
  }
  return unit as Unit;
}

function validAt(at: unknown): string {
  if (typeof at !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)) {
    failConfig(
      `interval.at must be a time "HH:MM" from "00:00" to "23:59", got ${show(at)}`,
    );
  }
  return at;
}

/** The first day of a week grid's weeks; undefined for every other unit. */
function validWeekStart(unit: Unit, weekStart: unknown): WeekDay | undefined {
  if (unit !== "week") {
    if (weekStart === undefined) return undefined;
    failConfig(`interval.weekStart is only for the unit "week"`);
  }
  const first = weekStart ?? 1;
  if (typeof first !== "number" || !WEEK_DAYS.includes(first)) {
    failConfig(
      `interval.weekStart must be an integer from 1 (Monday) to 7 (Sunday), got ${show(weekStart)}`,
    );
  }
  return first as WeekDay;
}

/** A zone the runtime knows; `"UTC"` needs no zone data. */
function validZone(zone: unknown): string {
  let known = typeof zone === "string" && zone.length > 0;
  if (known && zone !== "UTC") {
    try {
      formatterOf(zone as string);
    } catch {
      known = false;
    }
  }
  if (!known) {
    failConfig(
      `interval.zone must be an IANA time zone the runtime resolves, got ${show(zone)}`,
    );
  }
  return zone as string;
}

/**
 * Validates a calendar interval and applies its defaults (§2.2): the result
 * is frozen, with `weekStart` present only for weeks. Throws ConfigError
 * naming the offending field.
 */
function resolveCalendarInterval(input: unknown): ResolvedCalendarInterval {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    failConfig(
      `interval must be a positive integer of ms or a calendar interval, got ${show(input)}`,
    );
  }
  const raw = input as Record<string, unknown>;
  const unit = validUnit(raw.unit);
  const at = validAt(raw.at ?? "00:00");
  const weekStart = validWeekStart(unit, raw.weekStart);
  const zone = validZone(raw.zone ?? "UTC");
  return Object.freeze({
    unit,
    zone,
    at,
    ...(weekStart === undefined ? {} : { weekStart }),
  });
}

/**
 * The grid of a config (§2.2): a fixed interval, a positive safe integer of
 * ms, with its offset normalised into [0, interval), or a calendar
 * interval, which takes no offset since its `zone` and `at` place the slots
 * (N109). Throws ConfigError naming the offending field.
 */
export function resolveGridFields(
  interval: unknown,
  alignmentOffset: unknown,
): { interval: number | ResolvedCalendarInterval; alignmentOffset: number } {
  if (typeof interval === "object" && interval !== null) {
    const calendar = resolveCalendarInterval(interval);
    if (alignmentOffset !== undefined && alignmentOffset !== 0) {
      failConfig(
        `alignmentOffset must be absent or 0 with a calendar interval, got ${show(alignmentOffset)}`,
      );
    }
    return { interval: calendar, alignmentOffset: 0 };
  }
  if (
    typeof interval !== "number" ||
    !Number.isSafeInteger(interval) ||
    interval <= 0
  ) {
    failConfig(`interval must be a positive integer, got ${show(interval)}`);
  }
  if (alignmentOffset === undefined) return { interval, alignmentOffset: 0 };
  if (
    typeof alignmentOffset !== "number" ||
    !Number.isSafeInteger(alignmentOffset)
  ) {
    failConfig(
      `alignmentOffset must be an integer, got ${show(alignmentOffset)}`,
    );
  }
  // Any integer offset names a grid, and offsets naming the same grid
  // resolve identically. Add interval only to a negative remainder:
  // `r + interval` then stays below interval, so the result is exact even
  // when interval nears 2^53. Math.abs turns a -0 remainder into 0.
  const r = alignmentOffset % interval;
  return { interval, alignmentOffset: r < 0 ? r + interval : Math.abs(r) };
}

/** Whether two resolved calendar intervals name one grid: field by field, zones as written (N112). */
export function sameCalendar(
  a: ResolvedCalendarInterval,
  b: ResolvedCalendarInterval,
): boolean {
  return (
    a.unit === b.unit &&
    a.zone === b.zone &&
    a.at === b.at &&
    a.weekStart === b.weekStart
  );
}

/**
 * The calendar grid of a descriptor in a context (default: one shared by
 * every caller that names none). Equal descriptors give the same grid, so
 * they share its tables. Throws ConfigError for an invalid descriptor.
 */
export function createCalendarGrid(
  descriptor: unknown,
  context?: CalendarGridContext,
): CalendarGrid {
  defaultContext ??= new Context({});
  const owner = (context as Context | undefined) ?? defaultContext;
  const resolved = resolveCalendarInterval(descriptor);
  const key = `${resolved.unit}|${resolved.zone}|${resolved.at}|${resolved.weekStart}`;
  let grid = owner.grids.get(key);
  if (grid === undefined) {
    grid = new Calendar(resolved, owner).grid;
    owner.grids.set(key, grid);
  }
  return grid;
}

/**
 * The grid of a resolved config: its own fixed grid, or the calendar grid
 * of its descriptor in `context`.
 */
export function gridOf(
  config: {
    interval: number | ResolvedCalendarInterval;
    alignmentOffset: number;
  },
  context?: CalendarGridContext,
): Grid {
  const { interval, alignmentOffset } = config;
  return typeof interval === "number"
    ? { interval, alignmentOffset }
    : createCalendarGrid(interval, context);
}

/**
 * One calendar grid (§4.1): slot numbering, the supported domain, the two
 * primitives and the tables of slot starts. Internal to this module's
 * functions, which every caller goes through.
 */
class Calendar {
  readonly grid: CalendarGrid;
  /** The first and last slot of the domain (N117). */
  readonly kMin: number;
  readonly kMax: number;
  /** What a put's `'misaligned'` error names. */
  readonly label: string;
  readonly #context: Context;
  readonly #zone: string;
  readonly #utc: boolean;
  /** `at` in ms after local midnight. */
  readonly #at: number;
  /** Months per slot; 0 for days and weeks. */
  readonly #months: number;
  /** Days per slot of a day or week grid, and the day number slot 0 starts on. */
  readonly #days: number;
  readonly #origin: number;
  /** The arithmetic outer bound of the domain, inclusive. */
  readonly #lo: number;
  readonly #hi: number;
  readonly #tables = new Map<number, Float64Array>();
  #lastBlock = Number.NaN;
  #lastTable: Float64Array | undefined;
  /** The offset resolutions of one `floorSlot`, for the slots from `#memoBase`. */
  readonly #memo = new Float64Array(6);
  #memoBase = 0;
  /** The start of the slot the last `#floor` returned. */
  #start = 0;

  constructor(descriptor: ResolvedCalendarInterval, context: Context) {
    const { unit, zone, at, weekStart } = descriptor;
    this.grid = Object.freeze({
      interval: descriptor,
      alignmentOffset: 0,
      calendar: this,
    });
    this.#context = context;
    this.#zone = zone;
    this.#utc = zone === "UTC";
    this.#at = (+at.slice(0, 2) * 60 + +at.slice(3)) * 60_000;
    this.#months = MONTHS[unit] ?? 0;
    this.#days = unit === "week" ? 7 : 1;
    // 1970-01-01 was a Thursday (ISO day 4): slot 0 of a week grid starts on
    // the last `weekStart` day at or before it.
    this.#origin = unit === "week" ? -((11 - (weekStart ?? 1)) % 7) : 0;
    const first = daysFromCivil(1, 1, 1);
    const last = daysFromCivil(9999, 12, 31);
    if (this.#months === 0) {
      // The units whose first local date lies in the years 1 to 9999.
      this.kMin = Math.ceil((first - this.#origin) / this.#days);
      this.kMax = Math.floor((last - this.#origin) / this.#days);
    } else {
      this.kMin = Math.ceil((-1969 * 12) / this.#months);
      this.kMax = Math.floor((8029 * 12 + 11) / this.#months);
    }
    this.#lo = this.#nominal(this.kMin) - DAY;
    this.#hi = this.#nominal(this.kMax + 1) + DAY;
    this.label = `the start of a ${unit}${weekStart === undefined ? "" : ` (from day ${weekStart})`} in ${zone} at ${at}`;
  }

  /** The slot's first local date at `at`, read as UTC: calendar arithmetic only. */
  #nominal(k: number): number {
    if (this.#months === 0) {
      return (k * this.#days + this.#origin) * DAY + this.#at;
    }
    const month = k * this.#months;
    const year = Math.floor(month / 12);
    return (
      daysFromCivil(1970 + year, month - year * 12 + 1, 1) * DAY + this.#at
    );
  }

  /** The slot whose nominal start is at or before `t`. */
  #candidate(t: number): number {
    const day = Math.floor(t / DAY);
    return this.#months === 0
      ? Math.floor((day - this.#origin) / this.#days)
      : Math.floor(monthIndex(day) / this.#months);
  }

  /**
   * The instant at which the zone's clock reads the local time `nominal`
   * (given as if the zone were UTC), in at most three offset lookups
   * (N111): a local time that a transition skips resolves after the shift,
   * and one that occurs twice to the earlier instant.
   */
  resolve(nominal: number): number {
    if (this.#utc) return nominal;
    const offsetAt = this.#context.offsetAt;
    const before = offsetAt(this.#zone, nominal - DAY);
    const first = nominal - before;
    const at = offsetAt(this.#zone, first);
    if (at === before) return first;
    const second = nominal - at;
    return offsetAt(this.#zone, second) === at ? second : first;
  }

  /**
   * A start from two resolutions (N123): the slot's own instant, unless it
   * is not before the next slot's, and then one millisecond before that, so
   * the slot of a local date the zone skipped keeps a start of its own.
   */
  #alone(k: number): number {
    const own = this.resolve(this.#nominal(k));
    const next = this.resolve(this.#nominal(k + 1));
    return own < next ? own : next - 1;
  }

  /** The held table of a block, marked as used; undefined when none is held. */
  #table(block: number): Float64Array | undefined {
    if (block === this.#lastBlock) return this.#lastTable;
    const table = this.#tables.get(block);
    if (table !== undefined) {
      this.#context.touch(table);
      this.#lastBlock = block;
      this.#lastTable = table;
    }
    return table;
  }

  /** Forgets an evicted table. */
  drop(block: number): void {
    this.#tables.delete(block);
    if (block === this.#lastBlock) this.#lastBlock = Number.NaN;
  }

  /** The slots of a block that lie within the margin `startOf` accepts. */
  #span(block: number): SlotRange {
    return {
      start: Math.max(block * BLOCK, this.kMin - 2),
      end: Math.min(block * BLOCK + BLOCK - 1, this.kMax + 2),
    };
  }

  /** Computes a block's table whole: one resolution per slot and one more. */
  #fill(block: number): void {
    const { start, end } = this.#span(block);
    const table = new Float64Array(BLOCK);
    let own = this.resolve(this.#nominal(start));
    for (let k = start; k <= end; k++) {
      const next = this.resolve(this.#nominal(k + 1));
      table[k - block * BLOCK] = own < next ? own : next - 1;
      own = next;
    }
    this.#tables.set(block, table);
    this.#context.hold(table, this, block);
  }

  /**
   * The fill rule (N124): computes the table of each block that the
   * conversion about to run needs more than half of. `values` are the
   * ascending slots a read returns, or the timestamps of a put, whose
   * candidate slots stand for their slots.
   */
  warm(values: ArrayLike<number>, n: number, instants: boolean): void {
    if (this.#utc) return;
    let block = Number.NaN;
    let count = 0;
    for (let i = 0; i < n; i++) {
      const at = instants
        ? this.#blockOfInstant(values[i])
        : Math.floor((values[i] as number) / BLOCK);
      if (at === block) count++;
      else {
        this.#need(block, count);
        block = at;
        count = 1;
      }
    }
    this.#need(block, count);
  }

  /** The block of a put timestamp's candidate slot; NaN for what no slot can hold. */
  #blockOfInstant(t: unknown): number {
    return typeof t === "number" && t >= this.#lo && t <= this.#hi
      ? Math.floor(this.#candidate(t) / BLOCK)
      : Number.NaN;
  }

  /** Computes a block's table when `count` starts are more than half of what it holds. */
  #need(block: number, count: number): void {
    if (Number.isNaN(block) || this.#tables.has(block)) return;
    const { start, end } = this.#span(block);
    const held = end - start + 1;
    if (held > 0 && count > held / 2) this.#fill(block);
  }

  /** A slot's start without the margin check: from its table, or alone. */
  #startOf(k: number): number {
    if (this.#utc) return this.#nominal(k);
    const block = Math.floor(k / BLOCK);
    const table = this.#table(block);
    return table === undefined
      ? this.#alone(k)
      : (table[k - block * BLOCK] as number);
  }

  #beyond(k: number): never {
    throw new InvalidRangeError(
      `slot ${show(k)} is outside the calendar's domain, the years 1 to 9999`,
    );
  }

  /**
   * The instant slot `k` starts at, for `kMin − 2` to `kMax + 2`: the two
   * slots beyond each end are what `floorSlot` steps over at the edges.
   * Throws InvalidRangeError for any other `k`, before any lookup.
   */
  startOf(k: number): number {
    if (!(Number.isInteger(k) && k >= this.kMin - 2 && k <= this.kMax + 2)) {
      this.#beyond(k);
    }
    return this.#startOf(k);
  }

  /** As `startOf`, for a slot of the domain only (`toMs`). */
  domainStart(k: number): number {
    return this.has(k) ? this.#startOf(k) : this.#beyond(k);
  }

  /** Whether `k` is a slot of the domain. */
  has(k: number): boolean {
    return Number.isInteger(k) && k >= this.kMin && k <= this.kMax;
  }

  /** One resolution of a `#floor`, kept for the slots its steps share. */
  #resolved(k: number): number {
    const i = k - this.#memoBase;
    let instant = this.#memo[i] as number;
    if (Number.isNaN(instant)) {
      instant = this.resolve(this.#nominal(k));
      this.#memo[i] = instant;
    }
    return instant;
  }

  /** A start for `#floor`: NaN beyond the margin, else from a table or two resolutions. */
  #near(k: number): number {
    if (k < this.kMin - 2 || k > this.kMax + 2) return Number.NaN;
    const block = Math.floor(k / BLOCK);
    const table = this.#table(block);
    if (table !== undefined) return table[k - block * BLOCK] as number;
    const own = this.#resolved(k);
    const next = this.#resolved(k + 1);
    return own < next ? own : next - 1;
  }

  /**
   * The slot at or before `t`, with its start left in `#start`; NaN when
   * `t` is outside the domain. The arithmetic outer bound is checked before
   * any lookup.
   */
  #floor(t: number): number {
    if (!(t >= this.#lo && t <= this.#hi)) return Number.NaN;
    const k = this.#utc ? this.#floorUtc(t) : this.#floorZoned(t);
    return k >= this.kMin && k <= this.kMax ? k : Number.NaN;
  }

  /** In UTC a slot's start is its nominal start: no stepping, no lookup. */
  #floorUtc(t: number): number {
    const k = this.#candidate(t - this.#at);
    this.#start = this.#nominal(k);
    return k;
  }

  /**
   * From the slot of `t`'s UTC date the answer is at most one slot above
   * and two below, since every offset is under a day, so it takes at most
   * four resolutions (12 lookups). NaN when a start it needs lies beyond
   * the margin, which leaves the answer outside the domain.
   */
  #floorZoned(t: number): number {
    const candidate = this.#candidate(t);
    this.#memo.fill(Number.NaN);
    this.#memoBase = candidate - 2;
    const start = this.#near(candidate);
    if (Number.isNaN(start)) return Number.NaN;
    return start > t
      ? this.#below(candidate, t)
      : this.#from(candidate, start, t);
  }

  /** The first of the two slots below `candidate` that starts at or before `t`. */
  #below(candidate: number, t: number): number {
    for (let k = candidate - 1; k >= candidate - 2; k--) {
      this.#context.onFloorStep?.(-1);
      const start = this.#near(k);
      if (start > t) continue;
      this.#start = start;
      return Number.isNaN(start) ? Number.NaN : k;
    }
    return Number.NaN;
  }

  /** `candidate`, which starts at or before `t`, or the slot above it. */
  #from(candidate: number, start: number, t: number): number {
    const next = this.#near(candidate + 1);
    if (Number.isNaN(next)) return Number.NaN;
    if (next > t) {
      this.#start = start;
      return candidate;
    }
    this.#context.onFloorStep?.(1);
    this.#start = next;
    return candidate + 1;
  }

  #outside(t: number): never {
    throw new InvalidRangeError(
      `timestamp ${show(t)} is outside the calendar's domain, the years 1 to 9999 in ${this.#zone}`,
    );
  }

  /** The slot at or before `t`; InvalidRangeError outside the domain. */
  floorSlot(t: number): number {
    const k = this.#floor(t);
    return Number.isNaN(k) ? this.#outside(t) : k;
  }

  /** The slot `t` starts, or NaN when `t` is no slot's start. */
  slotIfAligned(t: number): number {
    if (!Number.isSafeInteger(t)) return Number.NaN;
    const k = this.#floor(t);
    return !Number.isNaN(k) && this.#start === t ? k : Number.NaN;
  }

  /**
   * The first slot that starts at or after `t`, which may be `kMax + 1`;
   * InvalidRangeError when `t` is outside the domain.
   */
  ceilSlot(t: number): number {
    const k = this.floorSlot(t);
    return this.#start === t ? k : k + 1;
  }

  /** As `ceilSlot`, for a slot that must exist (a range end, a watermark). */
  slotAtOrAfter(t: number): number {
    const k = this.ceilSlot(t);
    return k > this.kMax ? this.#outside(t) : k;
  }

  /**
   * Converts the first `n` timestamps of a put into `out`, after the fill
   * rule: the index of the first one that is no slot's start, or `n`.
   */
  slotsOf(timestamps: ArrayLike<number>, n: number, out: Float64Array): number {
    this.warm(timestamps, n, true);
    for (let i = 0; i < n; i++) {
      const k = this.slotIfAligned(timestamps[i] as number);
      if (Number.isNaN(k)) return i;
      out[i] = k;
    }
    return n;
  }

  /** Replaces a read's ascending slots by their starts, after the fill rule. */
  startsInto(slots: Float64Array): void {
    this.warm(slots, slots.length, false);
    for (let i = 0; i < slots.length; i++) {
      slots[i] = this.startOf(slots[i] as number);
    }
  }

  /** The lookup budget of a `hydrate` or a load; undefined for a UTC calendar, which looks nothing up. */
  get lookupBudget(): number | undefined {
    return this.#utc ? undefined : this.#context.lookupBudget;
  }
}

/**
 * Slot of the fixed grid point at or before `t`: floor((t - offset) / interval).
 *
 * Computed from `t % interval` and comparisons instead of the literal
 * formula, because `t - offset` leaves exact-integer range for timestamps
 * near ±2^53 and a float division could round across a slot boundary.
 */
function fixedFloor(t: number, g: FixedGrid): number {
  const r = t % g.interval; // sign of t, |r| < interval
  const q = (t - r) / g.interval; // exact: t - r is a multiple of interval
  if (r >= g.alignmentOffset) return q;
  return r >= g.alignmentOffset - g.interval ? q - 1 : q - 2;
}

function fixedAligned(t: number, g: FixedGrid): boolean {
  if (!Number.isSafeInteger(t)) return false;
  const r = t % g.interval;
  return r === g.alignmentOffset || r === g.alignmentOffset - g.interval;
}

/**
 * Timestamp of a fixed slot: alignmentOffset + slot * interval.
 *
 * For a negative slot the product alone can pass -2^53 before the positive
 * offset brings the sum back, so it is regrouped as
 * (slot + 1) * interval + (alignmentOffset - interval): both terms then
 * share the result's sign and neither exceeds it in magnitude.
 */
function fixedMs(slot: number, g: FixedGrid): number {
  if (slot >= 0) return g.alignmentOffset + slot * g.interval;
  return (slot + 1) * g.interval + (g.alignmentOffset - g.interval);
}

/**
 * The slot at or before `t`, the first primitive. On a calendar grid it
 * throws InvalidRangeError for a `t` outside the domain; on a fixed grid it
 * is arithmetic, and the callers below check the domain.
 */
export function floorSlot(t: number, g: Grid): number {
  return g.calendar === undefined ? fixedFloor(t, g) : g.calendar.floorSlot(t);
}

/**
 * The instant a slot starts at, the second primitive (`msOf` generalised).
 * On a calendar grid it throws InvalidRangeError for a slot more than two
 * beyond the domain.
 */
export function startOf(slot: number, g: Grid): number {
  return msOf(slot, g);
}

/** The G6 resolution of a nominal local time on a calendar grid (the test seam of §4.1). */
export function resolveCalendarStart(nominal: number, g: Grid): number {
  return g.calendar === undefined ? nominal : g.calendar.resolve(nominal);
}

/**
 * True when `t` is a safe integer lying exactly on the grid. Anything
 * outside the supported domain (fractions, NaN, |t| >= 2^53, an instant
 * outside a calendar's domain) is not.
 */
export function isAligned(t: number, g: Grid): boolean {
  if (g.calendar === undefined) return fixedAligned(t, g);
  return !Number.isNaN(g.calendar.slotIfAligned(t));
}

/**
 * Slot of an aligned timestamp. Throws RangeError otherwise: callers
 * validate first (put validation reports PutError 'misaligned').
 */
export function slotOf(t: number, g: Grid): number {
  if (g.calendar !== undefined) {
    const k = g.calendar.slotIfAligned(t);
    if (!Number.isNaN(k)) return k;
    throw new RangeError(`timestamp ${t} is not ${g.calendar.label}`);
  }
  if (!fixedAligned(t, g)) {
    throw new RangeError(
      `timestamp ${t} is not on the grid t ≡ ${g.alignmentOffset} (mod ${g.interval})`,
    );
  }
  return fixedFloor(t, g);
}

/** Timestamp of a slot: `startOf`, under the name the fixed grid gave it. */
export function msOf(slot: number, g: Grid): number {
  return g.calendar === undefined ? fixedMs(slot, g) : g.calendar.startOf(slot);
}

/** What a put's `'misaligned'` error expects of a timestamp. */
export function describeGrid(g: Grid): string {
  return g.calendar === undefined
    ? `t ≡ ${g.alignmentOffset} (mod ${g.interval})`
    : g.calendar.label;
}

/**
 * Whether a slot has a timestamp callers may use: on a fixed grid a
 * safe-integer one, on a calendar grid a slot of the domain.
 */
export function inDomain(slot: number, g: Grid): boolean {
  return g.calendar === undefined
    ? Number.isSafeInteger(slot) && Number.isSafeInteger(fixedMs(slot, g))
    : g.calendar.has(slot);
}

/**
 * A put's timestamps as slots (§4.3), the grid kind decided once: converts
 * the first `n` into `out` and returns the index of the first that is not
 * aligned, or `n`.
 */
export function slotsOf(
  timestamps: ArrayLike<number>,
  n: number,
  g: Grid,
  out: Float64Array,
): number {
  if (g.calendar !== undefined) return g.calendar.slotsOf(timestamps, n, out);
  for (let i = 0; i < n; i++) {
    const t = timestamps[i] as number;
    if (!fixedAligned(t, g)) return i;
    out[i] = fixedFloor(t, g);
  }
  return n;
}

/** A read's ascending slots as timestamps, in place (§4.4), the grid kind decided once. */
export function msInto(slots: Float64Array, g: Grid): void {
  if (g.calendar !== undefined) {
    g.calendar.startsInto(slots);
    return;
  }
  for (let i = 0; i < slots.length; i++) {
    slots[i] = fixedMs(slots[i] as number, g);
  }
}

/**
 * The offset lookups one `hydrate` or one load on this grid may cause
 * (N113); undefined for a grid that looks nothing up.
 */
export function lookupBudgetOf(g: Grid): number | undefined {
  return g.calendar?.lookupBudget;
}

/** Rejects a range that is not two ordered finite numbers within ±(2^53 − 1). */
function assertRange(r: Range): void {
  // Untyped callers (plain JS, RPC params) can pass anything. isFinite does
  // not coerce, so "10", null and booleans are rejected, not read as numbers.
  const supported = (t: unknown) =>
    Number.isFinite(t) && Math.abs(t as number) <= Number.MAX_SAFE_INTEGER;
  if (typeof r !== "object" || r === null) {
    throw new InvalidRangeError(`range must be an object, got ${show(r)}`);
  }
  if (!supported(r.start) || !supported(r.end)) {
    throw new InvalidRangeError(
      `range endpoints must be finite numbers within ±(2^53 - 1), got [${show(r.start)}, ${show(r.end)}]`,
    );
  }
  if (r.start > r.end) {
    throw new InvalidRangeError(
      `range start ${r.start} is after its end ${r.end}`,
    );
  }
}

/**
 * Snaps a get/invalidate range outward to the grid: start floors, end ceils,
 * so the result is never narrower than the input (N1). `start === end` is
 * legal: one slot when aligned, the two surrounding slots otherwise.
 */
export function snapOut(r: Range, g: Grid): SlotRange {
  assertRange(r);
  if (g.calendar !== undefined) {
    return {
      start: g.calendar.floorSlot(r.start),
      end: g.calendar.slotAtOrAfter(r.end),
    };
  }
  const floorEnd = fixedFloor(r.end, g);
  const slots = {
    start: fixedFloor(r.start, g),
    end: fixedAligned(r.end, g) ? floorEnd : floorEnd + 1,
  };
  // Snapping outward can step past the last grid point that is a safe
  // integer; such a slot has no exact timestamp to report back.
  if (
    !Number.isSafeInteger(fixedMs(slots.start, g)) ||
    !Number.isSafeInteger(fixedMs(slots.end, g))
  ) {
    throw new InvalidRangeError(
      `range [${r.start}, ${r.end}] snaps to grid points beyond ±(2^53 - 1)`,
    );
  }
  return slots;
}

/**
 * Snaps a put's authority range inward: the grid points lying inside it, or
 * undefined when there is none (N13). Never wider than the input, so a put
 * cannot claim a slot its caller did not name, and every slot returned has a
 * timestamp of the domain.
 */
export function snapIn(r: Range, g: Grid): SlotRange | undefined {
  assertRange(r);
  let start: number;
  let end: number;
  if (g.calendar !== undefined) {
    start = g.calendar.ceilSlot(r.start);
    end = g.calendar.floorSlot(r.end);
  } else {
    const floorStart = fixedFloor(r.start, g);
    start = fixedAligned(r.start, g) ? floorStart : floorStart + 1;
    end = fixedFloor(r.end, g);
  }
  return start > end ? undefined : { start, end };
}

/** Rejects a timestamp that is not a finite number within ±(2^53 − 1). */
function assertTimestamp(t: number, what: string): void {
  if (!Number.isFinite(t) || Math.abs(t) > Number.MAX_SAFE_INTEGER) {
    throw new InvalidRangeError(
      `${what} must be a finite number within ±(2^53 - 1), got ${show(t)}`,
    );
  }
}

/**
 * First slot whose timestamp is at or after `t`: the watermark's slot, since
 * points at t >= finalizedUntil are provisional (§2.4). Throws
 * InvalidRangeError for an unsupported `t`, or when that slot lies outside
 * the domain.
 */
export function slotAtOrAfter(t: number, g: Grid): number {
  assertTimestamp(t, "timestamp");
  if (g.calendar !== undefined) return g.calendar.slotAtOrAfter(t);
  const floor = fixedFloor(t, g);
  const slot = fixedAligned(t, g) ? floor : floor + 1;
  if (!Number.isSafeInteger(fixedMs(slot, g))) {
    throw new InvalidRangeError(
      `the grid point at or after ${t} lies beyond ±(2^53 - 1)`,
    );
  }
  return slot;
}

/**
 * Slot range → inclusive ms Range (GetResult.coverage and misses). On a
 * calendar grid it throws InvalidRangeError for a slot outside the domain.
 */
export function toMs(r: SlotRange, g: Grid): Range {
  return g.calendar === undefined
    ? { start: fixedMs(r.start, g), end: fixedMs(r.end, g) }
    : {
        start: g.calendar.domainStart(r.start),
        end: g.calendar.domainStart(r.end),
      };
}
