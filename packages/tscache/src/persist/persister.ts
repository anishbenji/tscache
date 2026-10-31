/**
 * The persister (docs/architecture.md §4.10.6; N46, N49, N50, N54, N58, N59,
 * N61): loads persisted caches into an engine and writes their changes
 * behind, through one writer that runs one job at a time under one deadline
 * per job. Memory is canonical: a load applies only into a cache that knows
 * nothing, and a flush writes what memory holds without reading the disk.
 *
 * Timers and the store live here; the engine only reports its changes
 * (§4.10.4). No method rejects for a persistence failure: a failure stops
 * the cache's persistence and is reported through `onStopped`.
 */

import type { CacheChange, CacheState } from "../engine/cache";
import { cacheStateOf, type Engine, observeCaches } from "../engine/engine";
import { pageOf } from "../engine/merge";
import type { SlotRange } from "../grid";
import type { ClientEvents } from "../types";
import { recordsOf } from "./records";
import type { PageRange, PersistStore, StoredCache, WritePlan } from "./store";

export interface PersisterOptions {
  /** Quiet time before a flush is due, and the delay before a retry. Default 1000 ms. */
  debounceMs?: number;
  /** Longest a change waits before its flush is due. Default 5000 ms. */
  maxDelayMs?: number;
  /**
   * The one deadline (N61): how long a load may take from open(), and how
   * long a job of the writer (a flush, a clearAll, a cleanup) has from the
   * moment it is due, whatever it waits for. Default 5000 ms.
   */
  timeoutMs?: number;
  /** Called once for each cache whose persistence stops. */
  onStopped?: (event: ClientEvents["persistStopped"]) => void;
}

type StopEvent = ClientEvents["persistStopped"];
type Reason = StopEvent["reason"];
type Failure = { name: string; message: string };
type OpenStore = (options?: {
  ifExists?: boolean;
}) => Promise<PersistStore | undefined>;

/** Every page of a cache. */
const EVERY_PAGE: PageRange = { start: -Infinity, end: Infinity };

/** A cache under persistence, from its first open() on. */
interface Tracked {
  readonly id: string;
  readonly state: CacheState;
  status: "loading" | "running" | "stopped";
  /** Settles open(): after the load, its abandonment or the cache's stop. */
  readonly opened: Promise<void>;
  readonly resolveOpened: () => void;
  loadTimer: ReturnType<typeof setTimeout> | undefined;
  /** Dirty state: page ranges (merged, ascending), a full rewrite, the cache record. */
  pages: PageRange[];
  rewrite: boolean;
  meta: boolean;
  /** The first and the latest quiet-spell change not yet taken by a flush. */
  first: number | undefined;
  last: number | undefined;
  /** `remove` and `clear` changes recorded, and how many of them are durable (N58). */
  removals: number;
  durable: number;
  /** durable() calls, each waiting for the count it saw. */
  waiters: { count: number; resolve: () => void }[];
  /** At most one queued and one running flush job (§4.10.6, Scheduling). */
  queued: Job | undefined;
  running: Job | undefined;
  /** Stopped: whether the cleanup after the stop has settled, or there is none. */
  cleaned: boolean;
}

/** What a flush attempt took from its cache, put back if the attempt fails. */
interface Taken {
  pages: PageRange[];
  rewrite: boolean;
  meta: boolean;
  removals: number;
}

/** A write transaction of the writer (N61). */
interface Job {
  readonly kind: "flush" | "cleanup" | "clear";
  /** The flush's or the cleanup's cache. */
  readonly cache: Tracked | undefined;
  /** Creation order, to break ties between equal due times. */
  readonly seq: number;
  /**
   * Due time and deadline of the explicit requests (a removal, `flush`, a
   * retry). A queued flush is also due after its cache's quiet spell; the
   * effective values are `#dueOf` and `#deadlineOf`, frozen when it starts.
   */
  due: number;
  deadline: number;
  /** Settled with the job: its flush() callers, or its clearAll() callers. */
  readonly waiters: (() => void)[];
  /** The last rejected attempt's error. */
  error: Failure | undefined;
  /** The flush attempt running at a clearAll() call: no retry, no stop (§4.10.6). */
  final: boolean;
}

function failureOf(error: unknown): Failure {
  if (typeof error === "object" && error !== null) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return {
      name: typeof name === "string" ? name : "Error",
      message: typeof message === "string" ? message : String(error),
    };
  }
  return { name: "Error", message: String(error) };
}

/** Adds `range` to merged, ascending page ranges; adjacent ranges join. */
function addRange(ranges: PageRange[], range: PageRange): PageRange[] {
  const out: PageRange[] = [];
  let { start, end } = range;
  let placed = false;
  for (const r of ranges) {
    if (r.end + 1 < start) out.push(r);
    else if (end + 1 < r.start) {
      if (!placed) out.push({ start, end });
      placed = true;
      out.push(r);
    } else {
      start = Math.min(start, r.start);
      end = Math.max(end, r.end);
    }
  }
  if (!placed) out.push({ start, end });
  return out;
}

export class Persister {
  readonly #engine: Engine;
  readonly #openStore: OpenStore;
  readonly #debounceMs: number;
  readonly #maxDelayMs: number;
  readonly #timeoutMs: number;
  readonly #onStopped: ((event: StopEvent) => void) | undefined;
  readonly #tracked = new Map<string, Tracked>();

  #store: PersistStore | undefined;
  /** The store's opening in progress; `#openingIfExists` when a clear started it. */
  #opening: Promise<PersistStore | undefined> | undefined;
  #openingIfExists = false;
  /** Set when the store failed to open or a clearAll failed: nothing persists any more. */
  #failure: { reason: Reason; error: Failure | undefined } | undefined;

  /** Queued jobs, and the one whose attempt is running. */
  readonly #queue: Job[] = [];
  #current: Job | undefined;
  /** The pending clearAll job: the barrier (N54). */
  #barrier: Job | undefined;
  #seq = 0;
  /** The writer is being stepped; a nested #pump only asks for another step. */
  #pumping = false;
  #again = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #timerAt = Infinity;
  /** close() callers waiting for the writer to drain. */
  readonly #drainWaiters: (() => void)[] = [];
  #closing: Promise<void> | undefined;
  #closed = false;

  /**
   * `openStore` is called lazily: by the first open(), or by a clearAll()
   * before any open(), which passes { ifExists: true }. A store it returns is
   * kept for the persister's life; an `undefined` result (no database yet)
   * lets a later open() call it again.
   */
  constructor(
    engine: Engine,
    openStore: OpenStore,
    options: PersisterOptions = {},
  ) {
    this.#engine = engine;
    this.#openStore = openStore;
    this.#debounceMs = options.debounceMs ?? 1000;
    this.#maxDelayMs = options.maxDelayMs ?? 5000;
    this.#timeoutMs = options.timeoutMs ?? 5000;
    this.#onStopped = options.onStopped;
    observeCaches(engine, {
      onChange: (cacheId, change) => this.#change(cacheId, change),
      onMutate: (cacheId) => this.#mutate(cacheId),
    });
  }

  /** Starts persisting a cache: loads and applies its records. Idempotent. */
  open(cacheId: string): Promise<void> {
    const known = this.#tracked.get(cacheId);
    if (known !== undefined) return known.opened;
    let state: CacheState;
    try {
      state = cacheStateOf(this.#engine, cacheId);
    } catch (error) {
      return Promise.reject(error);
    }
    if (!state.config.persist || this.#closed) return Promise.resolve();
    const cache = this.#track(cacheId, state);
    if (this.#failure !== undefined) {
      // A failed opening or clearAll: nothing loads or persists any more.
      this.#stop(cache, this.#failure.reason, this.#failure.error, false);
    } else if (this.#barrier !== undefined) {
      // No load during a clearAll (§4.10.5 rule 3): cold, rewritten after it.
      this.#run(cache);
      cache.rewrite = true;
      this.#quiet(cache);
    } else {
      cache.loadTimer = setTimeout(() => {
        if (cache.status === "loading") this.#stop(cache, "unavailable");
      }, this.#timeoutMs);
      void this.#load(cache);
    }
    return cache.opened;
  }

  /**
   * Makes the flush of one cache, or of every running cache with dirty
   * state, due now; resolves when those jobs settled. Acknowledges nothing:
   * that is durable()'s job.
   */
  flush(cacheId?: string): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const caches =
      cacheId === undefined
        ? [...this.#tracked.values()]
        : [this.#tracked.get(cacheId)];
    const now = this.#now();
    const pending: Promise<void>[] = [];
    for (const cache of caches) {
      if (cache?.status !== "running") continue;
      if (this.#dirty(cache) || cache.queued !== undefined) {
        this.#request(cache, now);
      }
      const job = cache.queued ?? cache.running;
      if (job !== undefined) pending.push(this.#settles(job));
    }
    this.#arm();
    return Promise.all(pending).then(() => undefined);
  }

  /** How many removals (`remove` and `clear` changes) have been recorded for the cache; 0 when untracked. */
  removals(cacheId: string): number {
    return this.#tracked.get(cacheId)?.removals ?? 0;
  }

  /**
   * Resolves once every removal recorded for the cache so far is durable, or
   * once its persistence has stopped and its cleanup has settled (N58).
   */
  durable(cacheId: string): Promise<void> {
    const cache = this.#tracked.get(cacheId);
    if (cache === undefined) return Promise.resolve();
    const count = cache.status === "stopped" ? Infinity : cache.removals;
    if (cache.status === "stopped" ? cache.cleaned : cache.durable >= count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => cache.waiters.push({ count, resolve }));
  }

  /**
   * Empties the disk (N54), holding every flush and load until its job
   * settles; resolves once the disk is empty, or once every tracked cache
   * has stopped. The caller runs `Engine.clearAll()` in the same
   * synchronous step, just before.
   */
  clearAll(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    let job = this.#barrier;
    if (job === undefined) {
      const now = this.#now();
      job = this.#job("clear", undefined, now, now + this.#timeoutMs);
      this.#barrier = job;
      this.#queue.push(job);
      // Its plan predates the call: one final attempt (§4.10.6).
      if (this.#current?.kind === "flush") this.#current.final = true;
    }
    // A second call joins the pending job and takes over what changed since.
    for (const cache of this.#tracked.values()) {
      if (cache.status === "stopped") continue;
      // The engine's clear has abandoned a pending load already (rule 2).
      if (cache.status === "loading") this.#abandon(cache);
      this.#takeOver(cache, job);
    }
    const settled = this.#settles(job);
    this.#arm();
    return settled;
  }

  /** Flushes, then closes the store. */
  close(): Promise<void> {
    this.#closing ??= (async () => {
      const now = this.#now();
      for (const cache of this.#tracked.values()) {
        if (cache.status === "running" && this.#dirty(cache)) {
          this.#request(cache, now);
        }
      }
      this.#arm();
      await new Promise<void>((resolve) => {
        this.#drainWaiters.push(resolve);
        this.#checkDrained();
      });
      this.#closed = true;
      this.#disarm();
      this.#store?.close();
    })();
    return this.#closing;
  }

  // ── tracking and changes ──────────────────────────────────────────────

  #track(id: string, state: CacheState): Tracked {
    let resolveOpened!: () => void;
    const opened = new Promise<void>((resolve) => {
      resolveOpened = resolve;
    });
    const cache: Tracked = {
      id,
      state,
      status: "loading",
      opened,
      resolveOpened,
      loadTimer: undefined,
      pages: [],
      rewrite: false,
      meta: false,
      first: undefined,
      last: undefined,
      removals: 0,
      durable: 0,
      waiters: [],
      queued: undefined,
      running: undefined,
      cleaned: false,
    };
    this.#tracked.set(id, cache);
    return cache;
  }

  #change(cacheId: string, change: CacheChange): void {
    const cache = this.#tracked.get(cacheId);
    if (cache === undefined || cache.status === "stopped" || this.#closed) {
      return;
    }
    if (cache.status === "loading") this.#abandon(cache);
    switch (change.kind) {
      case "write":
        this.#mark(cache, change.slots);
        this.#quiet(cache);
        return;
      case "remove":
        this.#mark(cache, change.slots);
        cache.removals++;
        this.#request(cache, this.#now());
        return;
      case "clear":
        cache.rewrite = true;
        cache.removals++;
        this.#request(cache, this.#now());
        return;
      case "version":
        // Every page record names the version (§4.10.2).
        cache.rewrite = true;
        this.#quiet(cache);
        return;
      case "watermark":
        cache.meta = true;
        this.#quiet(cache);
        return;
    }
  }

  #mutate(cacheId: string): void {
    const cache = this.#tracked.get(cacheId);
    if (cache?.status === "loading" && !this.#closed) this.#abandon(cache);
  }

  /**
   * A mutation reached a loading cache (§4.10.5 rule 2): nothing stored is
   * applied, and the next flush rewrites the cache from memory.
   */
  #abandon(cache: Tracked): void {
    this.#run(cache);
    cache.rewrite = true;
    this.#quiet(cache);
  }

  /** The cache is running: its load is over, applied or abandoned. */
  #run(cache: Tracked): void {
    cache.status = "running";
    clearTimeout(cache.loadTimer);
    cache.loadTimer = undefined;
    cache.resolveOpened();
  }

  #mark(cache: Tracked, slots: SlotRange): void {
    const cap = cache.state.config.segmentSlotCap;
    cache.pages = addRange(cache.pages, {
      start: pageOf(slots.start, cap),
      end: pageOf(slots.end, cap),
    });
  }

  #dirty(cache: Tracked): boolean {
    return (
      cache.pages.length > 0 ||
      cache.rewrite ||
      cache.meta ||
      cache.removals > cache.durable
    );
  }

  /** A change that waits for the quiet spell, capped by maxDelayMs. */
  #quiet(cache: Tracked): void {
    const now = this.#now();
    cache.first ??= now;
    cache.last = now;
    this.#queuedJob(cache);
    this.#arm();
  }

  /** An explicit request: the cache's flush is due at `due`. */
  #request(cache: Tracked, due: number): void {
    const job = this.#queuedJob(cache);
    job.due = Math.min(job.due, due);
    job.deadline = Math.min(job.deadline, due + this.#timeoutMs);
    this.#arm();
  }

  /** The cache's one queued flush job, created when there is none. */
  #queuedJob(cache: Tracked): Job {
    if (cache.queued === undefined) {
      cache.queued = this.#job("flush", cache, Infinity, Infinity);
      this.#queue.push(cache.queued);
    }
    return cache.queued;
  }

  #job(
    kind: Job["kind"],
    cache: Tracked | undefined,
    due: number,
    deadline: number,
  ): Job {
    return {
      kind,
      cache,
      seq: this.#seq++,
      due,
      deadline,
      waiters: [],
      error: undefined,
      final: false,
    };
  }

  // ── loading ───────────────────────────────────────────────────────────

  async #load(cache: Tracked): Promise<void> {
    const store = await this.#ensureStore();
    if (store === undefined || cache.status !== "loading") return;
    let stored: StoredCache;
    try {
      stored = await store.read(cache.id);
    } catch (error) {
      if (cache.status === "loading") {
        this.#stop(cache, "error", failureOf(error));
      }
      return;
    }
    // Abandoned, stopped or timed out meanwhile: the result is ignored.
    if (cache.status !== "loading") return;
    // Running first, so the watermark change restore reports is recorded
    // as any change of a running cache.
    this.#run(cache);
    let rewrite: boolean;
    try {
      ({ rewrite } = cache.state.restore(stored));
    } catch (error) {
      this.#stop(cache, "error", failureOf(error));
      return;
    }
    if (rewrite) {
      cache.rewrite = true;
      this.#request(cache, this.#now());
      this.#pump();
    }
  }

  /**
   * The store, opened once per persister. When it cannot be opened, every
   * tracked cache and every later open stop with 'unavailable' (§4.10.6).
   */
  async #ensureStore(): Promise<PersistStore | undefined> {
    try {
      const store = await this.#storeFor(false);
      if (store === undefined) this.#openFailed(undefined);
      return store;
    } catch (error) {
      this.#openFailed(failureOf(error));
      return undefined;
    }
  }

  /**
   * Waits for the store, starting its opening when none is in progress:
   * with `ifExists` for a clear (no database: undefined, and none created).
   */
  async #storeFor(ifExists: boolean): Promise<PersistStore | undefined> {
    for (;;) {
      if (this.#store !== undefined) return this.#store;
      if (this.#opening === undefined) {
        this.#openingIfExists = ifExists;
        this.#opening = this.#startOpening(ifExists);
      }
      const byClear = this.#openingIfExists;
      const store = await this.#opening;
      // A clear's opening that found no database: a load or a flush opens it.
      if (store !== undefined || ifExists || !byClear) return store;
    }
  }

  async #startOpening(ifExists: boolean): Promise<PersistStore | undefined> {
    try {
      const store = await (ifExists
        ? this.#openStore({ ifExists: true })
        : this.#openStore());
      if (store !== undefined) {
        if (this.#closed) store.close();
        else this.#store = store;
      }
      return store;
    } finally {
      this.#opening = undefined;
    }
  }

  #openFailed(error: Failure | undefined): void {
    this.#atomically(() => {
      this.#failure ??= { reason: "unavailable", error };
      for (const cache of this.#tracked.values()) {
        this.#stop(cache, "unavailable", error, false);
      }
    });
  }

  // ── stopping ──────────────────────────────────────────────────────────

  /**
   * Stops a cache's persistence for good (N59): its dirty state and jobs go,
   * `onStopped` is called once, and, when a store is open and `cleanup`
   * holds, one cleanup job deletes its records.
   */
  #stop(cache: Tracked, reason: Reason, error?: Failure, cleanup = true): void {
    if (cache.status === "stopped") return;
    cache.status = "stopped";
    clearTimeout(cache.loadTimer);
    cache.loadTimer = undefined;
    this.#drop(cache);
    for (const job of [cache.queued, cache.running]) {
      if (job === undefined) continue;
      this.#unqueue(job);
      if (this.#current === job) this.#current = undefined;
      this.#settle(job);
    }
    cache.queued = undefined;
    cache.running = undefined;
    cache.resolveOpened();
    const event: StopEvent =
      error === undefined
        ? { cacheId: cache.id, reason }
        : { cacheId: cache.id, reason, error };
    try {
      this.#onStopped?.(event);
    } catch {
      // A listener's failure must not leave the writer half-updated.
    }
    if (cleanup && this.#store !== undefined) {
      const now = this.#now();
      this.#queue.push(this.#job("cleanup", cache, now, now + this.#timeoutMs));
    } else {
      this.#cleaned(cache);
    }
    this.#pump();
  }

  /** The stop's cleanup settled, or there is none: release durable(). */
  #cleaned(cache: Tracked): void {
    cache.cleaned = true;
    for (const waiter of cache.waiters.splice(0)) waiter.resolve();
  }

  /** Forgets the cache's dirty state. */
  #drop(cache: Tracked): void {
    cache.pages = [];
    cache.rewrite = false;
    cache.meta = false;
    cache.first = undefined;
    cache.last = undefined;
  }

  // ── clearAll ──────────────────────────────────────────────────────────

  /** The clear takes over the cache's dirty state and absorbs its queued flush. */
  #takeOver(cache: Tracked, clear: Job): void {
    this.#drop(cache);
    const queued = cache.queued;
    if (queued === undefined) return;
    this.#unqueue(queued);
    cache.queued = undefined;
    clear.waiters.push(...queued.waiters);
  }

  #clearSucceeded(job: Job): void {
    this.#barrier = undefined;
    this.#current = undefined;
    // The disk is empty, strict, and nothing was written after the clear.
    for (const cache of this.#tracked.values()) {
      if (cache.status !== "running") continue;
      cache.durable = cache.removals;
      this.#release(cache);
    }
    // Held requests are due at the later of their time and now, with a
    // deadline from then: time behind the barrier never counts.
    const now = this.#now();
    for (const held of this.#queue) {
      if (held.kind !== "flush" || this.#dueOf(held) > now) continue;
      held.due = now;
      held.deadline = now + this.#timeoutMs;
      const cache = held.cache as Tracked;
      cache.first = undefined;
      cache.last = undefined;
    }
    this.#settle(job);
  }

  /**
   * A failed clear stops every tracked cache, without a cleanup: it was
   * their cleanup. Nothing persists any more (D27).
   */
  #clearFailed(job: Job, reason: Reason, error: Failure | undefined): void {
    this.#atomically(() => {
      this.#barrier = undefined;
      this.#unqueue(job);
      if (this.#current === job) this.#current = undefined;
      this.#failure = { reason, error };
      for (const cache of this.#tracked.values()) {
        this.#stop(cache, reason, error, false);
      }
      this.#settle(job);
    });
  }

  // ── the writer ────────────────────────────────────────────────────────

  #now(): number {
    return performance.now();
  }

  #dueOf(job: Job): number {
    const cache = job.cache;
    if (
      job.kind !== "flush" ||
      cache === undefined ||
      cache.last === undefined
    ) {
      return job.due;
    }
    const quiet = Math.min(
      cache.last + this.#debounceMs,
      (cache.first as number) + this.#maxDelayMs,
    );
    return Math.min(job.due, quiet);
  }

  #deadlineOf(job: Job): number {
    const due = this.#dueOf(job);
    return Math.min(job.deadline, due + this.#timeoutMs);
  }

  /** During a clearAll no flush starts, and a held flush's deadline does not run. */
  #held(job: Job): boolean {
    return this.#barrier !== undefined && job.kind === "flush";
  }

  /** Jobs carrying a removal run before those that carry none (N61). */
  #carriesRemoval(job: Job): boolean {
    const cache = job.cache;
    return (
      job.kind !== "flush" ||
      (cache !== undefined && cache.removals > cache.durable)
    );
  }

  #unqueue(job: Job): void {
    const at = this.#queue.indexOf(job);
    if (at >= 0) this.#queue.splice(at, 1);
  }

  #settles(job: Job): Promise<void> {
    return new Promise((resolve) => job.waiters.push(resolve));
  }

  #settle(job: Job): void {
    for (const resolve of job.waiters.splice(0)) resolve();
  }

  /** Resolves the cache's durable() calls its durable count now covers. */
  #release(cache: Tracked): void {
    cache.waiters = cache.waiters.filter((waiter) => {
      if (waiter.count > cache.durable) return true;
      waiter.resolve();
      return false;
    });
  }

  /**
   * Steps the writer until nothing changes, then arms the timer for what
   * comes next. Called from the timer and when a job or a load settles;
   * a change (inside the engine's call) and the public methods only arm
   * the timer, so a job made due now starts after the caller's synchronous
   * step completes (N58).
   */
  #pump(): void {
    if (this.#pumping) {
      this.#again = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#again = false;
        this.#step();
      } while (this.#again);
    } finally {
      this.#pumping = false;
    }
    this.#checkDrained();
    this.#arm();
  }

  /** Runs `fn` as one step: a #pump it causes waits until it is done. */
  #atomically(fn: () => void): void {
    const nested = this.#pumping;
    this.#pumping = true;
    try {
      fn();
    } finally {
      this.#pumping = nested;
    }
    if (!nested && this.#again) this.#pump();
  }

  /**
   * Fails the jobs whose deadline has passed, then starts the next due job
   * when none runs.
   */
  #step(): void {
    const now = this.#now();
    const current = this.#current;
    if (current !== undefined && current.deadline <= now) this.#expire(current);
    for (const job of [...this.#queue]) {
      if (!this.#queue.includes(job) || this.#held(job)) continue;
      if (job.kind === "flush" && this.#dueOf(job) === Infinity) {
        // Its changes were taken by the running job: nothing to request.
        this.#unqueue(job);
        if (job.cache?.queued === job) job.cache.queued = undefined;
        this.#settle(job);
      } else if (this.#deadlineOf(job) <= now) {
        this.#expire(job);
      }
    }
    while (this.#current === undefined) {
      const next = this.#next(now);
      if (next === undefined) break;
      this.#start(next);
    }
  }

  /** The due job to run next: removal-carrying first, then by due time. */
  #next(now: number): Job | undefined {
    let best: Job | undefined;
    for (const job of this.#queue) {
      if (this.#held(job) || this.#dueOf(job) > now) continue;
      if (best === undefined || this.#before(job, best)) best = job;
    }
    return best;
  }

  #before(a: Job, b: Job): boolean {
    const ra = this.#carriesRemoval(a);
    if (ra !== this.#carriesRemoval(b)) return ra;
    const da = this.#dueOf(a);
    const db = this.#dueOf(b);
    return da !== db ? da < db : a.seq < b.seq;
  }

  #start(job: Job): void {
    this.#unqueue(job);
    // Frozen: the quiet spell is consumed when the attempt takes the state.
    job.deadline = this.#deadlineOf(job);
    job.due = this.#dueOf(job);
    const cache = job.cache;
    if (job.kind === "flush" && cache !== undefined) {
      if (cache.queued === job) cache.queued = undefined;
      if (!this.#dirty(cache)) {
        this.#settle(job);
        return;
      }
      cache.running = job;
    }
    this.#current = job;
    switch (job.kind) {
      case "flush":
        void this.#attemptFlush(job, cache as Tracked);
        return;
      case "cleanup":
        void this.#attemptCleanup(job, cache as Tracked);
        return;
      case "clear":
        void this.#attemptClear(job);
        return;
    }
  }

  /** The job's deadline passed, queued or running: it fails for good (N61). */
  #expire(job: Job): void {
    this.#unqueue(job);
    if (this.#current === job) this.#current = undefined;
    const cache = job.cache;
    switch (job.kind) {
      case "flush": {
        if (cache === undefined) return;
        if (cache.queued === job) cache.queued = undefined;
        if (cache.running === job) cache.running = undefined;
        this.#settle(job);
        // The attempt running at a clearAll() ends without a stop.
        if (job.final) return;
        const reason = job.error === undefined ? "unavailable" : "error";
        this.#stop(cache, reason, job.error);
        return;
      }
      case "cleanup":
        this.#settle(job);
        if (cache !== undefined) this.#cleaned(cache);
        return;
      case "clear":
        this.#clearFailed(
          job,
          job.error === undefined ? "unavailable" : "error",
          job.error,
        );
        return;
    }
  }

  /** The job ended (success, or a final attempt's failure): the next one may start. */
  #finish(job: Job): void {
    const cache = job.cache;
    if (cache?.running === job) cache.running = undefined;
    if (this.#current === job) this.#current = undefined;
    this.#settle(job);
    this.#pump();
  }

  async #attemptFlush(job: Job, cache: Tracked): Promise<void> {
    const store = await this.#ensureStore();
    if (store === undefined || this.#current !== job) return;
    const taken = this.#take(cache);
    if (taken === undefined) {
      this.#finish(job);
      return;
    }
    try {
      await store.write(cache.id, this.#plan(cache, taken));
    } catch (error) {
      if (this.#current === job) this.#rejected(job, cache, taken, error);
      return;
    }
    // Abandoned at its deadline: the result is ignored.
    if (this.#current !== job) return;
    cache.durable = Math.max(cache.durable, taken.removals);
    this.#release(cache);
    this.#finish(job);
  }

  /**
   * Takes (and resets) the dirty state in one synchronous step, so the plan
   * is built from one state; undefined when nothing is dirty.
   */
  #take(cache: Tracked): Taken | undefined {
    if (!this.#dirty(cache)) return undefined;
    const taken: Taken = {
      pages: cache.pages,
      rewrite: cache.rewrite,
      meta: cache.meta,
      removals: cache.removals,
    };
    this.#drop(cache);
    return taken;
  }

  /** The plan from memory alone: a flush never reads the disk (§4.10.6). */
  #plan(cache: Tracked, taken: Taken): WritePlan {
    const strict = taken.removals > cache.durable;
    const records = taken.rewrite
      ? recordsOf(cache.state)
      : recordsOf(cache.state, taken.pages);
    return {
      deletePages: taken.rewrite ? [{ ...EVERY_PAGE }] : taken.pages,
      putPages: records.pages,
      putCache: records.cache ?? null,
      strict,
    };
  }

  /** A rejected attempt: put the state back and retry after debounceMs, under the same deadline. */
  #rejected(job: Job, cache: Tracked, taken: Taken, error: unknown): void {
    job.error = failureOf(error);
    if (job.final) {
      // The clear holds this state now; no retry, no stop.
      this.#finish(job);
      return;
    }
    for (const range of taken.pages) cache.pages = addRange(cache.pages, range);
    cache.rewrite ||= taken.rewrite;
    cache.meta ||= taken.meta;
    cache.running = undefined;
    this.#current = undefined;
    const retry = this.#now() + this.#debounceMs;
    const queued = cache.queued;
    if (queued === undefined) {
      job.due = retry;
      cache.queued = job;
      this.#queue.push(job);
    } else {
      // One job per cache: the retry joins the queued one, earliest deadline.
      queued.due = Math.min(queued.due, retry);
      queued.deadline = Math.min(queued.deadline, job.deadline);
      queued.error = job.error;
      queued.waiters.push(...job.waiters.splice(0));
    }
    this.#pump();
  }

  async #attemptCleanup(job: Job, cache: Tracked): Promise<void> {
    const store = this.#store;
    if (store !== undefined) {
      try {
        await store.write(cache.id, {
          deletePages: [{ ...EVERY_PAGE }],
          putPages: [],
          putCache: null,
          strict: true,
        });
      } catch {
        // Its failure is ignored: the records stay (§4.10.1).
      }
    }
    if (this.#current !== job) return;
    this.#cleaned(cache);
    this.#finish(job);
  }

  async #attemptClear(job: Job): Promise<void> {
    let store: PersistStore | undefined;
    try {
      store = await this.#storeFor(true);
    } catch (error) {
      if (this.#current === job) {
        this.#clearFailed(job, "unavailable", failureOf(error));
        this.#pump();
      }
      return;
    }
    if (this.#current !== job) return;
    if (store !== undefined) {
      try {
        await store.clearAll();
      } catch (error) {
        if (this.#current !== job) return;
        job.error = failureOf(error);
        job.due = this.#now() + this.#debounceMs;
        this.#current = undefined;
        this.#queue.push(job);
        this.#pump();
        return;
      }
      if (this.#current !== job) return;
    }
    // Without a database there was nothing to clear (§4.10.6).
    this.#clearSucceeded(job);
    this.#pump();
  }

  // ── timer ─────────────────────────────────────────────────────────────

  /** Sets the one timer to the next due time or deadline. */
  #arm(): void {
    if (this.#closed) return;
    const current = this.#current;
    let next = current === undefined ? Infinity : current.deadline;
    for (const job of this.#queue) {
      if (this.#held(job)) continue;
      next = Math.min(next, this.#deadlineOf(job));
      if (current === undefined) next = Math.min(next, this.#dueOf(job));
    }
    if (next === this.#timerAt) return;
    this.#disarm();
    if (next === Infinity) return;
    this.#timerAt = next;
    const delay = Math.max(0, Math.ceil(next - this.#now()));
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#timerAt = Infinity;
      this.#pump();
    }, delay);
  }

  #disarm(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Infinity;
  }

  #checkDrained(): void {
    if (
      this.#queue.length > 0 ||
      this.#current !== undefined ||
      this.#barrier !== undefined
    ) {
      return;
    }
    for (const resolve of this.#drainWaiters.splice(0)) resolve();
  }
}
