// Following a cache's changes, the same in every framework (architecture
// §2.7, N84): a view listens to cacheChanged for its cache and, when an
// event touches the range it shows, reads that range again, at most once
// per animation frame. When any event of the frame wrote nothing and
// cleared or withdrew coverage over the view, it reads with a fetch;
// otherwise from the cache alone. A fetching read after every event would
// loop over a volatile tail: the fetch writes, the write sends an event,
// the event fetches again. A framework adapter calls `follow` with each
// client's cache handle and turns `reread` into its own reactivity.

import type {
  CacheHandle,
  ClientEvents,
  GetResult,
  Range,
} from "@anishbenji/tscache";

type Changed = ClientEvents["cacheChanged"];

/** How a view reads its range again: with a fetch, or from the cache alone. */
export type Reread = "fetch" | "cache";

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** A cache's grid, as its config names it. */
export interface Grid {
  interval: number;
  /** Default 0. */
  alignmentOffset?: number;
}

/**
 * `range` snapped outward to the grid: what a read of it returns (§2.3,
 * N1), from the grid point at or before its start to the one at or after
 * its end. The root entry does not export the package's grid module, so
 * this is the same rule, in milliseconds.
 */
function snappedOut(
  range: Range,
  { interval, alignmentOffset = 0 }: Grid,
): Range {
  const floor = (t: number) =>
    alignmentOffset + Math.floor((t - alignmentOffset) / interval) * interval;
  const ceil = (t: number) =>
    alignmentOffset + Math.ceil((t - alignmentOffset) / interval) * interval;
  return { start: floor(range.start), end: ceil(range.end) };
}

/**
 * What one event asks of a view showing `shown` (N84): a cache-only read
 * when it wrote something and touched the view, a fetching read when it
 * wrote nothing and cleared or withdrew coverage over the view, else
 * nothing. With `grid`, the view is the range as read, snapped outward: an
 * unaligned view shows the grid points at both its edges too, and a change
 * there is a change on screen (round 2, R2-1).
 */
export function reaction(
  event: Changed,
  range: Range,
  grid?: Grid,
): Reread | undefined {
  const shown = grid === undefined ? range : snappedOut(range, grid);
  if (event.written.length > 0) {
    const touched =
      event.cleared ||
      event.written.some((r) => overlaps(r, shown)) ||
      event.removed.some((r) => overlaps(r, shown));
    return touched ? "cache" : undefined;
  }
  if (event.cleared || event.removed.some((r) => overlaps(r, shown))) {
    return "fetch";
  }
  return undefined;
}

/** Schedules `callback` for the next frame; returns its cancel. */
export type Frame = (callback: () => void) => () => void;

/** The browser's next animation frame; a zero timer where there is none. */
export const nextFrame: Frame = (callback) => {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(() => callback());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(callback, 0);
  return () => clearTimeout(id);
};

export interface ChangeWatchOptions {
  /** The range the view shows now; undefined while it shows none. */
  shown(): Range | undefined;
  /**
   * The cache's grid: an event is judged against the shown range snapped
   * outward to it, the range a read returns. Without it, the raw range.
   */
  grid?: Grid;
  /** Reads the shown range again; called at most once per frame. */
  reread(how: Reread): void;
  /**
   * Read the cache alone once after each new subscription, for an adapter
   * that subscribes only after its first read went out: a change between
   * that read and the subscription is then shown too.
   */
  catchUp?: boolean;
  /**
   * The frame scheduler, for tests and for a view that reads only while it
   * is on screen (React). Default: the next animation frame.
   */
  frame?: Frame;
}

/**
 * One view's listening to its cache. `follow` subscribes to a client's
 * handle, replacing the previous client's; `dispose` stops. A hidden tab
 * runs no animation frame, so it reads once when it shows again.
 */
export class ChangeWatch {
  readonly #options: ChangeWatchOptions;
  readonly #frame: Frame;
  #cache: CacheHandle | undefined;
  #unsubscribe: () => void = () => {};
  /** The frame's read so far, while one is scheduled. */
  #pending: Reread | undefined;
  #cancel: () => void = () => {};

  constructor(options: ChangeWatchOptions) {
    this.#options = options;
    this.#frame = options.frame ?? nextFrame;
  }

  /**
   * Listens to `cache`; a no-op for the handle already followed. Call it
   * before reading through the handle, so no change between the read and
   * the subscription is missed (subscribe, then read).
   *
   * `client.cache()` gives a new handle on every call, so the new handle
   * is subscribed before the old one is released: on the same client the
   * client's listener count goes 1, 2, 1 and nothing is posted, so there is
   * no moment without a subscription in which another tab's change could
   * be missed. A new client's handle subscribes on its own port.
   */
  follow(cache: CacheHandle): void {
    if (cache === this.#cache) return;
    const release = this.#unsubscribe;
    this.#cache = cache;
    this.#unsubscribe = cache.on("cacheChanged", (event) => {
      const shown = this.#options.shown();
      const how =
        shown === undefined
          ? undefined
          : reaction(event, shown, this.#options.grid);
      if (how !== undefined) this.schedule(how);
    });
    release();
    if (this.#options.catchUp === true) this.schedule("cache");
  }

  /**
   * The view started a read of its own (a new range, a refresh), after the
   * events so far arrived: that read shows them, so a cache-only read the
   * frame would make is dropped, and a fetching one too when this read
   * fetches. Port messages arrive in order, so nothing the dropped read
   * would show is missing from this one.
   */
  started(fetching: boolean): void {
    if (this.#pending === undefined) return;
    if (this.#pending === "fetch" && !fetching) return;
    this.#cancel();
    this.#cancel = () => {};
    this.#pending = undefined;
  }

  /** Stops listening; a read scheduled for the frame is dropped. */
  dispose(): void {
    this.#unsubscribe();
    this.#unsubscribe = () => {};
    this.#cache = undefined;
    this.#cancel();
    this.#pending = undefined;
  }

  /** Schedules a read of `how` for the next frame, as an event would. */
  schedule(how: Reread): void {
    if (this.#pending !== undefined) {
      if (how === "fetch") this.#pending = "fetch";
      return;
    }
    this.#pending = how;
    this.#cancel = this.#frame(() => {
      const read = this.#pending;
      this.#pending = undefined;
      this.#cancel = () => {};
      if (read !== undefined) this.#options.reread(read);
    });
  }
}

type Miss = GetResult["misses"][number];

/**
 * A cache-only answer that keeps what the answer before it knew about its
 * misses. Only a fetch can say that a range failed (`fetch-failed`) or
 * waits for credentials (`auth-pending`); a cache-only read labels every
 * miss `uncached`. Where `previous` labelled a slot that is still missing,
 * `next` keeps that label, so a change re-read never hides a failure the
 * view showed. A fetching read replaces the labels: pass its answer as is.
 * `interval` is the cache's: misses lie on its grid.
 */
export function keepFailures(
  previous: GetResult | undefined,
  next: GetResult,
  interval: number,
): GetResult {
  const labelled = (previous?.misses ?? []).filter(
    (miss) => miss.reason !== "uncached",
  );
  if (labelled.length === 0) return next;
  const misses: Miss[] = [];
  for (const miss of next.misses) {
    if (miss.reason !== "uncached") {
      misses.push(miss);
      continue;
    }
    let cursor = miss.range.start;
    for (const label of labelled) {
      const start = Math.max(label.range.start, cursor);
      const end = Math.min(label.range.end, miss.range.end);
      if (start > end) continue;
      if (start > cursor) {
        misses.push({
          ...miss,
          range: { start: cursor, end: start - interval },
        });
      }
      misses.push({ ...label, range: { start, end } });
      cursor = end + interval;
    }
    if (cursor <= miss.range.end) {
      misses.push({ ...miss, range: { start: cursor, end: miss.range.end } });
    }
  }
  return { ...next, misses };
}

/**
 * A cache-only read that lands after `base`, the view's previous answer:
 * it starts only once `base` has settled, and keeps its failure labels
 * (`keepFailures`). Starting it any earlier could replace an answer that
 * has not landed yet, and lose what only that answer says: that a fetch
 * failed, or waits for credentials.
 */
export function cacheOnlyAfter(
  base: Promise<GetResult> | undefined,
  read: () => Promise<GetResult>,
  interval: number,
): Promise<GetResult> {
  if (base === undefined) return read();
  return base.then(
    (previous) => read().then((next) => keepFailures(previous, next, interval)),
    () => read(),
  );
}

/** A read a view started, as {@link ChangeHold} follows it. */
interface StartedRead {
  /** Whether it fetches (a cache-only read holds nothing). */
  fetching: boolean;
  /** Its answer: the read has settled once this settles. */
  answer: Promise<unknown>;
}

/**
 * Whether a view's cache-only change must wait, and when it comes back:
 * the hold of `ViewReads`, which every adapter reads through, so the rule
 * is written once.
 *
 * - Only the latest read the view started counts. An older one that
 *   latest-wins has dropped holds nothing, and its settling releases
 *   nothing.
 * - While that read fetches and has not settled, a cache-only change is
 *   held: reading now would replace the answer that alone says whether
 *   the fetch failed.
 * - When that read settles, a held change is released through `release`
 *   (the frame scheduler), so the framework has applied the answer before
 *   the view reads again.
 * - A cache-only read started meanwhile shows the change: the hold ends.
 */
class ChangeHold {
  readonly #release: () => void;
  #latest: StartedRead | undefined;
  #settled = false;
  #held = false;

  /** `release` asks the view to read again: through the frame. */
  constructor(release: () => void) {
    this.#release = release;
  }

  /**
   * The view started `read`, its latest. Idempotent for the same read, so
   * a render that runs twice reports it once.
   */
  started(read: StartedRead): void {
    if (read === this.#latest) return;
    this.#latest = read;
    this.#settled = false;
    if (!read.fetching) {
      this.#held = false;
      return;
    }
    const settled = () => {
      if (read !== this.#latest) return;
      this.#settled = true;
      if (!this.#held) return;
      this.#held = false;
      this.#release();
    };
    read.answer.then(settled, settled);
  }

  /** Whether a change asking for `how` waits; a held one comes back later. */
  holds(how: Reread): boolean {
    if (how !== "cache") return false;
    if (this.#latest?.fetching !== true || this.#settled) return false;
    this.#held = true;
    return true;
  }
}

/** How a read of the view is to read: decided by the changes, or forced. */
export type ReadMode = "auto" | "fetch" | "cache";

/** A read {@link ViewReads.read} started. */
export interface ViewRead {
  /** Whether it reads the cache alone. */
  cacheOnly: boolean;
  /** The answer to show, failure labels kept; the view applies latest-wins. */
  answer: Promise<GetResult>;
}

export interface ViewReadsOptions {
  /** The range the view shows now; undefined while it shows none. */
  shown(): Range | undefined;
  /** The cache's interval: misses lie on its grid. */
  interval: number;
  /**
   * The cache's alignment offset (default 0): with `interval`, the grid an
   * event is judged on, so a change at a snapped edge of the view counts.
   */
  alignmentOffset?: number;
  /**
   * A change asks the view to read its range again: run the view's read.
   * `how` is how that read reads while the view has not moved: an adapter
   * whose reads show as loading uses it to keep a read from the cache
   * alone out of that state.
   */
  reread(how: Reread): void;
  /**
   * The frame scheduler, for tests and for a view that reads only while it
   * is on screen (React). Default: the next animation frame.
   */
  frame?: Frame;
}

/**
 * One view's reads, and its following of the cache, in one place, so the
 * order no adapter may change is kept here (architecture §2.7, N84):
 *
 * 1. A read follows the client's handle, then reads (subscribe, then read).
 * 2. It reads the cache alone only when a change asked for that and the
 *    view did not move: the same range by value (a fresh object with the
 *    same endpoints is the same range) and the same owner, the client's
 *    connection state, by identity (a new client is a new view). Otherwise
 *    it fetches.
 * 3. A cache-only change that arrives while the latest read started is a
 *    fetching read still in flight is held: reading now would replace the
 *    answer that alone says whether the fetch failed. An older fetching
 *    read that latest-wins has dropped holds nothing.
 * 4. A held change is released only after that read's answer has
 *    resolved, and through the frame scheduler, so the framework has
 *    applied that answer before the view reads again; a cache-only read
 *    started meanwhile already shows it.
 * 5. A cache-only answer keeps the failure labels of the answer before it.
 *
 * The adapter's part is only framework glue: calling `read` from its
 * reactivity, applying latest-wins, and calling `dispose` on teardown.
 */
export class ViewReads {
  readonly #options: ViewReadsOptions;
  readonly #watch: ChangeWatch;
  #how: Reread | undefined;
  /** What the previous read was of: its range's endpoints and its owner. */
  #last: { start: number; end: number; owner: unknown } | undefined;
  /** Holds a cache-only change while the latest read fetches. */
  readonly #hold: ChangeHold;
  /** The answer of the latest read started, once it resolved. */
  #landed: Promise<GetResult> | undefined;
  #disposed = false;

  constructor(options: ViewReadsOptions) {
    this.#options = options;
    // Through the frame: by then the framework has applied the answer.
    this.#hold = new ChangeHold(() => this.#watch.schedule("cache"));
    this.#watch = new ChangeWatch({
      shown: options.shown,
      grid: {
        interval: options.interval,
        alignmentOffset: options.alignmentOffset ?? 0,
      },
      reread: (how) => this.#ask(how),
      ...(options.frame === undefined ? {} : { frame: options.frame }),
    });
  }

  /**
   * Reads `range` through `cache` (the client's handle, or its promise).
   * `owner` is what the cache belongs to, the client's connection state or
   * the client, compared by identity; the range is compared by value.
   * `mode` forces a fetch or a cache-only read.
   */
  read(
    cache: CacheHandle | Promise<CacheHandle>,
    range: Range,
    owner: unknown,
    mode: ReadMode = "auto",
  ): ViewRead {
    const last = this.#last;
    const same =
      last !== undefined &&
      last.owner === owner &&
      last.start === range.start &&
      last.end === range.end;
    const cacheOnly =
      mode === "cache" || (mode === "auto" && same && this.#how === "cache");
    this.#how = undefined;
    this.#last = { start: range.start, end: range.end, owner };
    const get = () =>
      Promise.resolve(cache).then((handle) => {
        if (!this.#disposed) {
          this.#watch.follow(handle);
          this.#watch.started(!cacheOnly);
        }
        return handle.get(range, { cacheOnly });
      });
    const answer = cacheOnly
      ? cacheOnlyAfter(this.#landed, get, this.#options.interval)
      : get();
    this.#landed = answer;
    this.#hold.started({ fetching: !cacheOnly, answer });
    return { cacheOnly, answer };
  }

  /** Stops following the cache; a read scheduled for the frame is dropped. */
  dispose(): void {
    this.#disposed = true;
    this.#watch.dispose();
  }

  #ask(how: Reread): void {
    // A fetch already asked for this frame takes the change with it.
    if (this.#how !== "fetch" && this.#hold.holds(how)) return;
    this.#how = how === "fetch" || this.#how === "fetch" ? "fetch" : "cache";
    this.#options.reread(this.#how);
  }
}
