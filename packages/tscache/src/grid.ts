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

/**
 * The runtime's offset formatters, by the name the runtime itself gives a
 * zone: every spelling of one zone shares one, so the map is bounded by the
 * zones the runtime knows, whatever a page sends.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Formatters built so far: what a zone check or a new grid costs (tests). */
let built = 0;

/** A formatter of a zone's offset; throws RangeError for a zone the runtime does not know. */
function newFormatter(zone: string): Intl.DateTimeFormat {
  built++;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    timeZoneName: "longOffset",
  });
}

const OFFSET = /GMT(?:([+-])(\d+)(?::(\d+))?(?::(\d+))?)?$/;

/**
 * The offset in ms a formatted instant ends with: "…, GMT-04:56:02",
 * "…, GMT+05:45" or "…, GMT". The en-US locale writes the sign as an ASCII
 * hyphen in every runtime the library runs in.
 */
function parseOffset(text: string): number {
  const match = OFFSET.exec(text);
  if (match === null) throw new RangeError(`no zone offset in "${text}"`);
  const [, sign, h = "0", m = "0", s = "0"] = match;
  const ms = (+h * 3600 + +m * 60 + +s) * 1000;
  return sign === "-" ? -ms : ms;
}

/**
 * A zone's UTC offset in ms at an instant, from the runtime's zone data
 * (N108). The formatter is the one kept for the zone's own name.
 */
function intlOffsetOf(zone: string): (instant: number) => number {
  const made = newFormatter(zone);
  const name = made.resolvedOptions().timeZone;
  const format = formatters.get(name) ?? made;
  formatters.set(name, format);
  return (instant) => parseOffset(format.format(instant));
}

/** What `calendarGridInternals` reads (tests): no package entry exports it. */
export function calendarGridInternals(): {
  /** Formatters kept, one per zone the runtime knows that a grid uses. */
  formatters: number;
  /** Formatters built so far, the ones a zone check throws away included. */
  built: number;
  /** Grids and tables the shared context holds (the grid entry's). */
  grids: number;
  tables: number;
} {
  return {
    formatters: formatters.size,
    built,
    grids: defaultContext?.gridCount ?? 0,
    tables: defaultContext?.tableCount ?? 0,
  };
}

/** The calendar grids a context holds (tests): no package entry exports it. */
export function heldGrids(context: CalendarGridContext): number {
  return (context as Context).gridCount;
}

/** The tables a grid references (tests): no package entry exports it. */
export function heldTables(g: Grid): number {
  return g.calendar?.heldTables ?? 0;
}

/**
 * Grids the shared context holds at most (S2.2). A page can pass the grid
 * entry any number of descriptors, a zone in every spelling among them;
 * an engine's own context holds one grid for each descriptor of its caches
 * and needs no bound.
 */
const SHARED_GRIDS = 64;

class Context implements CalendarGridContext {
  readonly #offsetAt: ((zone: string, instant: number) => number) | undefined;
  readonly onFloorStep: ((direction: -1 | 1) => void) | undefined;
  readonly lookupBudget: number;
  readonly #capacity: number;
  /** One grid per descriptor as written, least recently asked for first. */
  readonly #grids = new Map<string, CalendarGrid>();
  /** Grids held at most; above it the least recently asked for is dropped. */
  readonly #gridCapacity: number;
  #recentGrid: string | undefined;
  /** Every table held, least recently used first, with its owner and block. */
  readonly #order = new Map<Float64Array, { owner: Calendar; block: number }>();
  /** The table used last: using it again changes nothing in the order. */
  #recent: Float64Array | undefined;

  constructor(options: CalendarGridOptions, gridCapacity: number = Infinity) {
    this.#gridCapacity = gridCapacity;
    this.#offsetAt = options.offsetAt;
    this.onFloorStep = options.onFloorStep;
    this.lookupBudget = options.lookupBudget ?? LOOKUP_BUDGET;
    this.#capacity = options.tableCapacity ?? TABLE_CAPACITY;
  }

  get tableCount(): number {
    return this.#order.size;
  }

  get gridCount(): number {
    return this.#grids.size;
  }

  /** The grid held under a key, marked as the most recently asked for. */
  grid(key: string): CalendarGrid | undefined {
    const grid = this.#grids.get(key);
    if (grid !== undefined && key !== this.#recentGrid) {
      this.#grids.delete(key);
      this.#grids.set(key, grid);
      this.#recentGrid = key;
    }
    return grid;
  }

  /**
   * Holds a new grid, dropping the least recently asked for above the
   * capacity. A dropped grid gives up its tables and goes on working for
   * whoever still holds it; the next request for its descriptor makes a
   * new one.
   */
  keep(key: string, grid: CalendarGrid): void {
    this.#grids.set(key, grid);
    this.#recentGrid = key;
    while (this.#grids.size > this.#gridCapacity) {
      const [oldest, dropped] = this.#grids.entries().next().value as [
        string,
        CalendarGrid,
      ];
      this.#grids.delete(oldest);
      dropped.calendar.release();
    }
  }

  /** Stops holding a table its grid gave up. */
  forget(table: Float64Array): void {
    this.#order.delete(table);
    if (table === this.#recent) this.#recent = undefined;
  }

  /** A zone's offset function: the injected rules, or the runtime's. */
  offsetOf(zone: string): (instant: number) => number {
    const injected = this.#offsetAt;
    return injected === undefined
      ? intlOffsetOf(zone)
      : (instant) => injected(zone, instant);
  }

  /**
   * Marks a held table as the most recently used. Called for every use,
   * so the common case, the table used last, is one comparison.
   */
  touch(table: Float64Array): void {
    if (table === this.#recent) return;
    const entry = this.#order.get(table);
    if (entry === undefined) return;
    this.#order.delete(table);
    this.#order.set(table, entry);
    this.#recent = table;
  }

  /** Holds a new table, dropping the least recently used ones above the capacity. */
  hold(table: Float64Array, owner: Calendar, block: number): void {
    this.#order.set(table, { owner, block });
    this.#recent = table;
    while (this.#order.size > this.#capacity) {
      const [oldest, entry] = this.#order.entries().next().value as [
        Float64Array,
        { owner: Calendar; block: number },
      ];
      this.#order.delete(oldest);
      if (oldest === this.#recent) this.#recent = undefined;
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
  // The default is for an absent field only: null is a value, and invalid.
  const first = weekStart === undefined ? 1 : weekStart;
  if (typeof first !== "number" || !WEEK_DAYS.includes(first)) {
    failConfig(
      `interval.weekStart must be an integer from 1 (Monday) to 7 (Sunday), got ${show(weekStart)}`,
    );
  }
  return first as WeekDay;
}

/**
 * A zone the runtime knows and whose offset it can report; `"UTC"` needs no
 * zone data. The formatter it tries is thrown away: nothing is kept for a
 * config that may still be rejected, or for a spelling (S1.1).
 */
function validZone(zone: unknown): string {
  let known = typeof zone === "string" && zone.length > 0;
  if (known && zone !== "UTC") {
    try {
      parseOffset(newFormatter(zone as string).format(0));
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
  return withZone(calendarFields(input));
}

/** A calendar interval's fields with their defaults, the zone not yet checked. */
interface CalendarFields {
  unit: Unit;
  at: string;
  weekStart: WeekDay | undefined;
  zone: unknown;
}

function calendarFields(input: unknown): CalendarFields {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    failConfig(
      `interval must be a positive integer of ms or a calendar interval, got ${show(input)}`,
    );
  }
  const raw = input as Record<string, unknown>;
  const unit = validUnit(raw.unit);
  // A default is for an absent field only: null is a value, and invalid.
  const at = validAt(raw.at === undefined ? "00:00" : raw.at);
  const weekStart = validWeekStart(unit, raw.weekStart);
  return {
    unit,
    at,
    weekStart,
    zone: raw.zone === undefined ? "UTC" : raw.zone,
  };
}

/** The resolved interval of validated fields, once the zone is checked too. */
function withZone(fields: CalendarFields): ResolvedCalendarInterval {
  const { unit, at, weekStart } = fields;
  return Object.freeze({
    unit,
    zone: validZone(fields.zone),
    at,
    ...(weekStart === undefined ? {} : { weekStart }),
  });
}

/** A calendar interval takes no offset: its `zone` and `at` place the slots (N109). */
function assertNoOffset(alignmentOffset: unknown): void {
  if (alignmentOffset !== undefined && alignmentOffset !== 0) {
    failConfig(
      `alignmentOffset must be absent or 0 with a calendar interval, got ${show(alignmentOffset)}`,
    );
  }
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
    assertNoOffset(alignmentOffset);
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
  defaultContext ??= new Context({}, SHARED_GRIDS);
  const owner = (context as Context | undefined) ?? defaultContext;
  const fields = calendarFields(descriptor);
  // A grid the context holds was made from a checked zone: only a new one
  // pays for the check.
  const { zone } = fields;
  const key = `${fields.unit}|${fields.at}|${fields.weekStart}|${show(zone)}`;
  const held = typeof zone === "string" ? owner.grid(key) : undefined;
  if (held !== undefined) return held;
  const { grid } = new Calendar(withZone(fields), owner);
  owner.keep(key, grid);
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
 * The grid of a config's `interval` and `alignmentOffset`, as given (the
 * grid entry, §2.10), with `cache()`'s errors in `cache()`'s order. A
 * calendar grid the shared context already holds is returned without a
 * zone check, so a caller that asks per event or per frame pays for one
 * check per descriptor.
 */
export function resolveGrid(interval: unknown, alignmentOffset: unknown): Grid {
  if (typeof interval === "object" && interval !== null) {
    const grid = createCalendarGrid(interval);
    assertNoOffset(alignmentOffset);
    return grid;
  }
  return gridOf(resolveGridFields(interval, alignmentOffset));
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
  /** The zone's offset at an instant; undefined in UTC, where nothing is looked up. */
  readonly #offset: ((instant: number) => number) | undefined;
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
    this.#offset = this.#utc ? undefined : context.offsetOf(zone);
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
    const offset = this.#offset;
    if (offset === undefined) return nominal;
    const before = offset(nominal - DAY);
    const first = nominal - before;
    const at = offset(first);
    if (at === before) return first;
    const second = nominal - at;
    return offset(second) === at ? second : first;
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
    let table = this.#lastTable;
    if (block !== this.#lastBlock) {
      table = this.#tables.get(block);
      if (table === undefined) return undefined;
      this.#lastBlock = block;
      this.#lastTable = table;
    }
    // Every use counts in the context's order, this grid's last table
    // included: another grid may have used a table since (N124).
    if (table !== undefined) this.#context.touch(table);
    return table;
  }

  /** Forgets an evicted table. */
  drop(block: number): void {
    this.#tables.delete(block);
    if (block === this.#lastBlock) this.#forgetLast();
  }

  /** Clears the shortcut to the last table, the reference to it included. */
  #forgetLast(): void {
    this.#lastBlock = Number.NaN;
    this.#lastTable = undefined;
  }

  /** The tables this grid references: those it holds, and its shortcut's. */
  get heldTables(): number {
    const tables = new Set(this.#tables.values());
    if (this.#lastTable !== undefined) tables.add(this.#lastTable);
    return tables.size;
  }

  /** Gives up every table: the context no longer holds this grid. */
  release(): void {
    for (const table of this.#tables.values()) this.#context.forget(table);
    this.#tables.clear();
    this.#forgetLast();
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
   * The fill rule (N124), one block at a time: the end of the run of
   * values from `from` that count toward one block, whose table is
   * computed first when the run needs more than half of it. The caller
   * converts the run before it asks for the next, so a table is used before
   * a later fill can evict it, however few tables the context holds.
   * `values` are the ascending slots a read returns, or the timestamps of a
   * put, whose candidate slots stand for their slots.
   */
  #run(
    values: ArrayLike<number>,
    from: number,
    n: number,
    instants: boolean,
  ): number {
    if (this.#utc) return n;
    const block = this.#blockAt(values[from], instants);
    let end = from + 1;
    while (end < n && this.#blockAt(values[end], instants) === block) end++;
    this.#need(block, end - from);
    return end;
  }

  /** The block a value of a bulk conversion counts toward. */
  #blockAt(value: unknown, instants: boolean): number {
    return instants
      ? this.#blockOfInstant(value)
      : Math.floor((value as number) / BLOCK);
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
    let i = 0;
    while (i < n) {
      const end = this.#run(timestamps, i, n, true);
      for (; i < end; i++) {
        const k = this.slotIfAligned(timestamps[i] as number);
        if (Number.isNaN(k)) return i;
        out[i] = k;
      }
    }
    return n;
  }

  /** Replaces a read's ascending slots by their starts, a block's run at a time. */
  startsInto(slots: Float64Array): void {
    let i = 0;
    while (i < slots.length) {
      const end = this.#run(slots, i, slots.length, false);
      for (; i < end; i++) slots[i] = this.startOf(slots[i] as number);
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
 * The slot that contains `t`, for a caller outside the engine (the grid
 * entry, §2.10): `t` is checked as a watermark is, and the slot must have
 * a start to return. Throws InvalidRangeError otherwise.
 */
export function slotContaining(t: number, g: Grid): number {
  assertTimestamp(t, "timestamp");
  const slot = floorSlot(t, g);
  if (!inDomain(slot, g)) {
    throw new InvalidRangeError(
      `the grid point at or before ${t} lies beyond ±(2^53 - 1)`,
    );
  }
  return slot;
}

/**
 * The start of the slot after `slot`, a slot of the domain: the end of the
 * domain itself on a calendar grid's last slot. Throws InvalidRangeError
 * when a fixed grid's next point is no safe integer.
 */
export function startAfter(slot: number, g: Grid): number {
  const next = startOf(slot + 1, g);
  if (!Number.isSafeInteger(next)) {
    throw new InvalidRangeError(
      `the grid point after slot ${slot} lies beyond ±(2^53 - 1)`,
    );
  }
  return next;
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
