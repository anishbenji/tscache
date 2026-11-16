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

/**
 * What one event asks of a view showing `shown` (N84): a cache-only read
 * when it wrote something and touched the view, a fetching read when it
 * wrote nothing and cleared or withdrew coverage over the view, else
 * nothing.
 */
export function reaction(event: Changed, shown: Range): Reread | undefined {
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
  /** Reads the shown range again; called at most once per frame. */
  reread(how: Reread): void;
  /**
   * Read the cache alone once after each new subscription, for an adapter
   * that subscribes only after its first read went out: a change between
   * that read and the subscription is then shown too.
   */
  catchUp?: boolean;
  /** For tests: the frame scheduler. Default: the next animation frame. */
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
      const how = shown === undefined ? undefined : reaction(event, shown);
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

/** A read a reactive view started, as {@link NextRead.start} returns it. */
export interface StartedRead {
  /** Whether it reads the cache alone. */
  cacheOnly: boolean;
  /** Call once it settled, whether or not its answer landed. */
  settled(): void;
}

/**
 * Which kind of read a reactive view starts next. A change asks for one
 * (`ask`), and `bump` makes the view read again; the read then reads the
 * cache alone only when the change asked for that and nothing else of the
 * read moved: a new range or a new client always fetches.
 *
 * A cache-only read waits while a fetching read of the view is in flight.
 * Latest-wins would drop the fetching read's answer for it, and only that
 * answer says whether the fetch failed or met invalid credentials; nothing
 * else would tell the view. The change is asked again once the last
 * fetching read has settled, since the change may have landed after that
 * read took its answer; the adapter keeps the failure labels across it
 * with {@link keepFailures}.
 */
export class NextRead {
  readonly #bump: () => void;
  #how: Reread | undefined;
  #last: readonly unknown[] | undefined;
  /** Fetching reads started and not settled yet. */
  #fetching = 0;
  /** A cache-only change arrived while a fetching read was in flight. */
  #held = false;

  constructor(bump: () => void) {
    this.#bump = bump;
  }

  /** A change asks the view to read again, `how`; a fetch wins in a frame. */
  ask(how: Reread): void {
    if (how === "cache" && this.#how !== "fetch" && this.#fetching > 0) {
      this.#held = true;
      return;
    }
    this.#how = how === "fetch" || this.#how === "fetch" ? "fetch" : "cache";
    this.#bump();
  }

  /**
   * Starts the view's read over these inputs (the client's state and the
   * range, compared by identity): whether it reads the cache alone, and
   * the call that says it settled.
   */
  start(...inputs: readonly unknown[]): StartedRead {
    const last = this.#last;
    const same =
      last !== undefined &&
      last.length === inputs.length &&
      inputs.every((input, i) => input === last[i]);
    const cacheOnly = same && this.#how === "cache";
    this.#how = undefined;
    this.#last = inputs;
    if (cacheOnly) return { cacheOnly, settled: () => {} };
    this.#fetching++;
    let done = false;
    return {
      cacheOnly,
      settled: () => {
        if (done) return;
        done = true;
        this.#fetching--;
        if (this.#fetching > 0 || !this.#held) return;
        this.#held = false;
        this.ask("cache");
      },
    };
  }
}
