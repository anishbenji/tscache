// Following a cache's changes, the same in every framework (architecture
// §2.7, N84): a view listens to cacheChanged for its cache and, when an
// event touches the range it shows, reads that range again, at most once
// per animation frame. When any event of the frame wrote nothing and
// cleared or withdrew coverage over the view, it reads with a fetch;
// otherwise from the cache alone. A fetching read after every event would
// loop over a volatile tail: the fetch writes, the write sends an event,
// the event fetches again. A framework adapter calls `follow` with each
// client's cache handle and turns `reread` into its own reactivity.

import type { CacheHandle, ClientEvents, Range } from "@anishbenji/tscache";

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
   */
  follow(cache: CacheHandle): void {
    if (cache === this.#cache) return;
    this.#unsubscribe();
    this.#cache = cache;
    this.#unsubscribe = cache.on("cacheChanged", (event) => {
      const shown = this.#options.shown();
      const how = shown === undefined ? undefined : reaction(event, shown);
      if (how !== undefined) this.#schedule(how);
    });
    if (this.#options.catchUp === true) this.#schedule("cache");
  }

  /** Stops listening; a read scheduled for the frame is dropped. */
  dispose(): void {
    this.#unsubscribe();
    this.#unsubscribe = () => {};
    this.#cache = undefined;
    this.#cancel();
    this.#pending = undefined;
  }

  #schedule(how: Reread): void {
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

/**
 * Which kind of read a reactive view starts next. A change asks for one
 * (`ask`); the view's read then reads the cache alone only when the change
 * asked for that and nothing else of the read moved: a new range or a new
 * client always fetches.
 */
export class NextRead {
  #how: Reread | undefined;
  #last: readonly unknown[] | undefined;

  /** A change asks the view to read again, `how`; a fetch wins in a frame. */
  ask(how: Reread): void {
    this.#how = how === "fetch" || this.#how === "fetch" ? "fetch" : "cache";
  }

  /**
   * Whether the read about to start, over these inputs (the client's state
   * and the range, compared by identity), reads the cache alone.
   */
  cacheOnly(...inputs: readonly unknown[]): boolean {
    const last = this.#last;
    const same =
      last !== undefined &&
      last.length === inputs.length &&
      inputs.every((input, i) => input === last[i]);
    const only = same && this.#how === "cache";
    this.#how = undefined;
    this.#last = inputs;
    return only;
  }
}
