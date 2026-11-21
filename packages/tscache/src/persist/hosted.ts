/**
 * The SharedWorker hosting's persistence (docs/architecture.md §4.10.8):
 * what the RPC server calls, with the persister loaded lazily. The
 * persister, the IndexedDB adapter and `restore` are a chunk of their own
 * (`persist/lazy.ts`), imported at the first persisted cache's open or the
 * first `clearAll`, so an application that persists nothing never loads
 * them.
 *
 * Until the chunk has loaded, the server's calls wait in arrival order and
 * reach the persister in that order once it exists: `open`, and every op on
 * a cache whose open waits (and, once one op waits, every later op and
 * `clearAll`), so the persister sees each call where it would have seen it
 * had it been loaded all along. Ops on other caches run at once: no
 * persisted cache is tracked yet, so they concern nothing on disk.
 *
 * The import counts against the load's deadline (`timeoutMs`, N61): a
 * cache's open has `timeoutMs` from its call for the import and the load
 * together. An import that fails, or that has not settled `timeoutMs` after
 * it started, turns persistence off for the worker's life, as a store that
 * fails to open does (§4.10.6): every waiting and later open stops with
 * `'unavailable'`. Each such cache was stopped by its load, so its records
 * stay until its first later removal, which runs one strict cleanup through
 * the store opener, without the persister, and waits for it (user decision
 * 113 A, N59). In the worker the opener imports the same chunk: when the
 * import fails again, the cleanup fails, its failure is ignored and the
 * records stay, as for any cleanup.
 */

import type { CacheChange } from "../engine/cache";
import { type Engine, observeCaches } from "../engine/engine";
import type { Persistence } from "../rpc/server";
import type { ClientEvents } from "../types";
import type { durably, Persister, PersisterOptions } from "./persister";
import type { PersistStore, WritePlan } from "./store";

type StopEvent = ClientEvents["persistStopped"];
type Failure = { name: string; message: string };

/** Opens the store; `ifExists` for a clear (§4.10.6). */
export type OpenStore = (options?: {
  ifExists?: boolean;
}) => Promise<PersistStore | undefined>;

/** The lazily loaded chunk's exports, as this module uses them. */
export interface LazyPersist {
  Persister: typeof Persister;
  durably: typeof durably;
}

/** A stopped cache's cleanup (§4.10.6, Failures): every record goes, strict. */
const CLEANUP: WritePlan = {
  deletePages: [{ start: -Infinity, end: Infinity }],
  putPages: [],
  putCache: null,
  strict: true,
};

/** A cleanup the chunk's failure deferred, from its removal on. */
interface Cleanup {
  /** Removals recorded since it started, its own included; kept after it settles. */
  removals: number;
  /** Until it settles: a later removal waits for nothing. */
  settled: Promise<void> | undefined;
}

function failureOf(error: unknown): Failure {
  const { name, message } = (
    typeof error === "object" && error !== null ? error : {}
  ) as { name?: unknown; message?: unknown };
  return {
    name: typeof name === "string" ? name : "Error",
    message: typeof message === "string" ? message : String(error),
  };
}

export class HostedPersistence implements Persistence {
  readonly #engine: Engine;
  readonly #load: () => Promise<LazyPersist>;
  readonly #openStore: OpenStore;
  readonly #options: PersisterOptions;
  readonly #timeoutMs: number;
  #state: "idle" | "loading" | "ready" | "failed" = "idle";
  #persister: Persister | undefined;
  #durably: LazyPersist["durably"] | undefined;
  /** Why the chunk did not load: undefined for a timeout. */
  #failure: Failure | undefined;
  /** Calls waiting for the chunk, in arrival order. */
  readonly #waiting: ((persister: Persister | undefined) => void)[] = [];
  /** Caches whose open waits for the chunk. */
  readonly #pending = new Set<string>();
  /** Ops and clears among the waiting calls. */
  #held = 0;
  /** Caches stopped because the chunk did not load: each is reported once. */
  readonly #stopped = new Set<string>();
  /**
   * Their cleanups, from the first later removal on (user decision 113 A):
   * at most one per opened cache.
   */
  readonly #cleanups = new Map<string, Cleanup>();
  /** The store's opening for the cleanups, kept once it opened. */
  #store: Promise<PersistStore | undefined> | undefined;
  /**
   * The whole-store clear of a clearAll() after the chunk failed, while its
   * engine clear runs: the cleanups that clear starts are this clear.
   */
  #clearing: Promise<void> | undefined;

  /**
   * `load` imports the chunk; it is called once, at the first open or
   * clearAll. `options` are the persister's; `timeoutMs` also bounds the
   * import.
   */
  constructor(
    engine: Engine,
    load: () => Promise<LazyPersist>,
    openStore: OpenStore,
    options: PersisterOptions = {},
  ) {
    this.#engine = engine;
    this.#load = load;
    this.#openStore = openStore;
    this.#options = options;
    this.#timeoutMs = options.timeoutMs ?? 5000;
  }

  /** The persister once its chunk has loaded (for tests and diagnostics). */
  get persister(): Persister | undefined {
    return this.#persister;
  }

  open(cacheId: string): Promise<void> {
    const persister = this.#persister;
    if (persister !== undefined) return persister.open(cacheId);
    if (this.#state === "failed") {
      this.#stopUnloaded(cacheId);
      return Promise.resolve();
    }
    const startedAt = performance.now();
    this.#pending.add(cacheId);
    return this.#later((loaded) => {
      if (loaded !== undefined) return loaded.open(cacheId, startedAt);
      this.#stopUnloaded(cacheId);
      return undefined;
    });
  }

  durably(cacheId: string, op: () => unknown): unknown {
    const persister = this.#persister;
    if (persister !== undefined) {
      return (this.#durably as LazyPersist["durably"])(persister, cacheId, op);
    }
    if (this.#state === "failed") return this.#durablyUnloaded(cacheId, op);
    if (this.#state !== "loading") return op();
    if (!this.#pending.has(cacheId) && this.#held === 0) return op();
    this.#held++;
    return this.#later(() => this.durably(cacheId, op));
  }

  clearAll(clearMemory: () => void = () => this.#engine.clearAll()): unknown {
    if (this.#state === "loading" && this.#held > 0) {
      this.#held++;
      return this.#later(() => this.clearAll(clearMemory));
    }
    // After a chunk failure the whole store is emptied once, through the
    // store opener (user decision 123 A); the cleanups the engine's clear
    // starts are that clear.
    const store = this.#state === "failed" ? this.#clearStore() : undefined;
    this.#clearing = store;
    let failure: { error: unknown } | undefined;
    try {
      clearMemory();
    } catch (error) {
      // Every cache was cleared anyway (N22); the disk must follow.
      failure = { error };
    } finally {
      this.#clearing = undefined;
    }
    const persister = this.#persister;
    let cleared: Promise<unknown>;
    if (persister !== undefined) cleared = persister.clearAll();
    else if (store !== undefined) {
      // Cleanups started before the call are waited for too.
      cleared = Promise.all([
        store,
        ...[...this.#cleanups.values()].map((cleanup) => cleanup.settled),
      ]);
    }
    // Earlier sessions may have persisted: the chunk loads to empty the disk,
    // or, when it fails to load, the store opener does.
    else {
      cleared = this.#later((loaded) =>
        loaded === undefined ? this.#clearStore() : loaded.clearAll(),
      );
    }
    return cleared.then(() => {
      if (failure !== undefined) throw failure.error;
    });
  }

  flush(): void {
    const persister = this.#persister;
    if (persister !== undefined) void persister.flush();
    else if (this.#state === "loading") {
      void this.#later((loaded) => loaded?.flush());
    }
  }

  /** Runs `call` with the persister once the chunk settled (undefined: it did not load). */
  #later<T>(
    call: (persister: Persister | undefined) => T,
  ): Promise<Awaited<T>> {
    this.#start();
    return new Promise((resolve, reject) => {
      this.#waiting.push((persister) => {
        try {
          resolve(call(persister) as Awaited<T>);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /** Imports the chunk, once, under the load's deadline. */
  #start(): void {
    if (this.#state !== "idle") return;
    this.#state = "loading";
    const timer = setTimeout(() => this.#settle(undefined), this.#timeoutMs);
    this.#load().then(
      (chunk) => {
        clearTimeout(timer);
        this.#settle(chunk);
      },
      (error: unknown) => {
        clearTimeout(timer);
        this.#settle(undefined, failureOf(error));
      },
    );
  }

  /** The chunk loaded, failed or timed out: the waiting calls run, in order. */
  #settle(chunk: LazyPersist | undefined, error?: Failure): void {
    if (this.#state !== "loading") return;
    let failure = error;
    if (chunk !== undefined) {
      try {
        this.#persister = new chunk.Persister(
          this.#engine,
          this.#openStore,
          this.#options,
        );
        this.#durably = chunk.durably;
      } catch (thrown) {
        failure = failureOf(thrown);
      }
    }
    if (this.#persister === undefined) {
      this.#state = "failed";
      this.#failure = failure;
      observeCaches(this.#engine, {
        onChange: (cacheId, change) => this.#changed(cacheId, change),
        onMutate: () => {},
      });
    } else {
      this.#state = "ready";
    }
    this.#pending.clear();
    this.#held = 0;
    for (const run of this.#waiting.splice(0)) run(this.#persister);
  }

  /** A persisted cache opened without the chunk: its persistence stops. */
  #stopUnloaded(cacheId: string): void {
    if (this.#stopped.has(cacheId)) return;
    this.#stopped.add(cacheId);
    const error = this.#failure;
    const event: StopEvent =
      error === undefined
        ? { cacheId, reason: "unavailable" }
        : { cacheId, reason: "unavailable", error };
    this.#options.onStopped?.(event);
  }

  /**
   * An op without the chunk (persistence is off): it runs in its own call
   * and answers as it does, unless it, or another op meanwhile, recorded a
   * removal of a cache whose cleanup was deferred; then it answers, success
   * or failure, once that cleanup settled (N58, user decision 113 A). An op
   * that returns a promise is checked again when it settles, as `durably`
   * does: its removal may come after an await (a fetch bringing a new
   * version).
   */
  #durablyUnloaded(cacheId: string, op: () => unknown): unknown {
    const before = this.#cleanups.get(cacheId)?.removals ?? 0;
    const waited = (): Promise<void> | undefined => {
      const cleanup = this.#cleanups.get(cacheId);
      return cleanup !== undefined && cleanup.removals > before
        ? cleanup.settled
        : undefined;
    };
    let result: unknown;
    try {
      result = op();
    } catch (error) {
      const cleanup = waited();
      if (cleanup === undefined) throw error;
      return cleanup.then(() => Promise.reject(error));
    }
    if (result instanceof Promise) return result.finally(waited);
    const cleanup = waited();
    return cleanup === undefined ? result : cleanup.then(() => result);
  }

  /** A change after the chunk failed: a removal starts a deferred cleanup. */
  #changed(cacheId: string, change: CacheChange): void {
    if (change.kind !== "remove" && change.kind !== "clear") return;
    const started = this.#cleanups.get(cacheId);
    if (started !== undefined) {
      started.removals++;
      return;
    }
    if (!this.#stopped.has(cacheId)) return;
    const cleanup: Cleanup = {
      removals: 1,
      settled: (
        this.#clearing ??
        this.#bounded((store) => store.write(cacheId, CLEANUP))
      ).then(() => {
        cleanup.settled = undefined;
      }),
    };
    this.#cleanups.set(cacheId, cleanup);
  }

  /** Empties the whole store, strict, as `#bounded` runs it (user decision 123 A). */
  #clearStore(): Promise<void> {
    return this.#bounded((store) => store.clearAll());
  }

  /**
   * Runs one strict deletion through a store that exists, with the
   * persister's deadline and no retry; never rejects: a failure leaves the
   * records (§4.10.6, Failures).
   */
  #bounded(run: (store: PersistStore) => Promise<void>): Promise<void> {
    this.#store ??= this.#openStore({ ifExists: true });
    const opening = this.#store;
    // A failed opening is tried again by the next cleanup.
    const forget = () => {
      if (this.#store === opening) this.#store = undefined;
    };
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.#timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      opening
        .then((store) => {
          if (store === undefined) forget();
          return store && run(store);
        }, forget)
        .then(done, done);
    });
  }
}
