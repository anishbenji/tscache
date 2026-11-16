// tscache in Angular: the app's connection as a root service, and reads as
// resources. `provideTscache()` gives the service its `open`; the service
// connects in the browser only, turns the connection's state into a signal,
// and disposes it when the app is destroyed. `cacheResource()` reads through
// Angular's `resource()`, which drops an answer a newer range has overtaken;
// putting the connection's state in its params makes a client that replaces
// a lost one read again, with nothing reported. Server-rendered, the server's
// read travels in TransferState: it seeds every browser client and is
// the first value shown, so the hydration render matches the server's.

import { isPlatformBrowser, isPlatformServer } from "@angular/common";
import {
  DestroyRef,
  type EnvironmentProviders,
  InjectionToken,
  inject,
  linkedSignal,
  makeEnvironmentProviders,
  makeStateKey,
  PLATFORM_ID,
  type Resource,
  ResourceParamsStatus,
  type ResourceSnapshot,
  resource,
  resourceFromSnapshots,
  Service,
  type Signal,
  type StateKey,
  signal,
  TransferState,
  untracked,
} from "@angular/core";
import type {
  CacheConfig,
  CacheHandle,
  GetResult,
  Range,
  TscacheClient,
} from "@anishbenji/tscache";
import { ViewReads } from "../shared/changes";
import {
  type Connection,
  type ConnectionState,
  connect,
  type Seed,
} from "../shared/connection";
import {
  type Dehydrated,
  rehydrate,
  type ServerRead,
} from "../shared/hydration";

export interface TscacheOptions {
  /**
   * The caches the server read for this page (ssr-server.ts). Each one's
   * read seeds every client and is the first value of the first
   * `cacheResource()` for it.
   */
  hydrate?: readonly CacheConfig[];
}

interface Setup {
  open: () => Promise<TscacheClient>;
  hydrate: readonly CacheConfig[];
}

const SETUP = new InjectionToken<Setup>("tscache setup");

/**
 * Lets the app connect to tscache in the browser. `open` creates a client
 * (createClient with the worker and fetcher URLs as your bundler serves
 * them, docs/guides/worker-setup.md); it runs once per client, the first and
 * each that replaces a lost worker, so it can read current credentials.
 */
export function provideTscache(
  open: () => Promise<TscacheClient>,
  { hydrate = [] }: TscacheOptions = {},
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: SETUP, useValue: { open, hydrate } },
  ]);
}

/**
 * Reads a range on the server for `cacheResource()`. The server's config
 * provides it (ssr-server.ts); a server render without it fails to inject.
 */
export const SERVER_READER = new InjectionToken<
  (config: CacheConfig, range: Range) => Promise<GetResult>
>("tscache server reader");

/** Where the server's read of `config` travels to the browser. */
export function serverReadKey(config: CacheConfig): StateKey<Dehydrated> {
  return makeStateKey<Dehydrated>(`tscache:${config.id}`);
}

/**
 * The app's connection (shared/connection.ts): one for the app's lifetime,
 * disposed with the app. It connects in the browser only; on the server,
 * where `cacheResource()` reads through SERVER_READER, it stays connecting.
 */
@Service()
export class Tscache {
  /** Where the connection stands; a new object on each change. */
  readonly state: Signal<ConnectionState>;
  readonly #connection: Connection | undefined;
  readonly #serverReads = new Map<string, ServerRead>();

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) {
      this.state = signal<ConnectionState>({ status: "connecting" });
      this.#connection = undefined;
      return;
    }
    const { open, hydrate } = inject(SETUP);
    const transfer = inject(TransferState);
    const seeds: Seed[] = [];
    for (const config of hydrate) {
      const value = transfer.get(serverReadKey(config), null);
      if (value === null) continue;
      const read = rehydrate(config, value);
      seeds.push({ config, read });
      this.#serverReads.set(config.id, read);
    }
    const connection = connect(open, seeds);
    const state = signal(connection.state);
    connection.subscribe(() => state.set(connection.state));
    inject(DestroyRef).onDestroy(() => void connection.dispose());
    this.state = state.asReadonly();
    this.#connection = connection;
  }

  /**
   * `client`'s handle for `config`, opened once per client; every client's
   * is seeded with the server's read before it is handed out.
   */
  cache(client: TscacheClient, config: CacheConfig): Promise<CacheHandle> {
    if (this.#connection === undefined) {
      return Promise.reject(new Error("tscache connects in the browser only"));
    }
    return this.#connection.cache(client, config);
  }

  /** The server's read of `config`, for the first resource that asks. */
  takeServerRead(config: CacheConfig): ServerRead | undefined {
    const read = this.#serverReads.get(config.id);
    this.#serverReads.delete(config.id);
    return read;
  }
}

/** A cache-only answer, and the snapshot of the resource it was read after. */
interface Fresh<T> {
  after: ResourceSnapshot<T>;
  snapshot: ResourceSnapshot<T>;
}

/**
 * `source`, except that while it loads it goes on showing its last value,
 * or `initial` before it has one: Angular's withPreviousValue recipe
 * (angular.dev/guide/signals/resource, "Resource composition with
 * snapshots"). `fresh` goes over the source's snapshot it was read after,
 * and lapses when the source moves on.
 */
function withPreviousValue<T>(
  source: Resource<T>,
  initial: T,
  fresh: Signal<Fresh<T> | undefined>,
): Resource<T> {
  const snapshot = linkedSignal<
    { next: ResourceSnapshot<T>; over: Fresh<T> | undefined },
    ResourceSnapshot<T>
  >({
    source: () => ({ next: source.snapshot(), over: fresh() }),
    computation: ({ next, over }, previous) => {
      if (over?.after === next) return over.snapshot;
      if (next.status !== "loading") return next;
      if (previous === undefined) return { status: "loading", value: initial };
      if (previous.value.status === "error") return next;
      return { status: "loading", value: previous.value.value };
    },
  });
  return resourceFromSnapshots(snapshot);
}

/**
 * The cache's answer for `range()` of `config`, as a resource of the
 * component (or service) that calls it, in its injection context. The
 * latest range wins, and the answer shown stays while the next one loads
 * (status "loading"). `range()` returning undefined leaves it idle.
 *
 * A read rejected because the worker was lost is not an error: the
 * connection's next client reads again. A connection that failed, or a read
 * that fails on a live client, is: `error()`. A change to the cache over
 * the range, from any tab, reads it again, at most once per frame: from the
 * cache alone, or with a fetch after a change that wrote nothing
 * (architecture §2.7, shared/changes.ts). Only a read that may fetch is
 * "loading": a read from the cache alone, after a live bar say, replaces
 * the value while the status stays "resolved".
 */
export function cacheResource(
  config: CacheConfig,
  range: () => Range | undefined,
): Resource<GetResult | undefined> {
  if (isPlatformServer(inject(PLATFORM_ID))) {
    const read = inject(SERVER_READER);
    // resource() holds a pending task while it loads: the render waits.
    return resource({
      params: range,
      loader: ({ params }) => read(config, params),
    });
  }
  const tscache = inject(Tscache);
  const changed = signal(0);
  const fresh = signal<Fresh<GetResult | undefined> | undefined>(undefined);
  // What the resource last read: a change's cache-only read is for that
  // view only. After a move the resource reads the new range itself.
  let loaded: { client: TscacheClient; range: Range } | undefined;
  // Holds a change during a fetching read, keeps failure labels, and
  // releases after the answer landed (shared/changes.ts).
  const views = new ViewReads({
    shown: () => untracked(range),
    interval: config.interval,
    alignmentOffset: config.alignmentOffset ?? 0,
    reread: (how) => {
      // A read that may fetch goes through the resource, and shows as
      // loading. One from the cache alone is read here, so the resource
      // never loads for it, and its answer goes over the one shown.
      if (how === "fetch") return changed.update((n) => n + 1);
      const state = untracked(tscache.state);
      const asked = untracked(range);
      if (state.status !== "connected" || asked === undefined) return;
      // The view moved since the change (round 4 pre-review): the resource
      // is about to read where it moved to, so read nothing here.
      if (
        loaded === undefined ||
        loaded.client !== state.client ||
        loaded.range.start !== asked.start ||
        loaded.range.end !== asked.end
      ) {
        return;
      }
      const after = untracked(live.snapshot);
      const read = views.read(
        tscache.cache(state.client, config),
        asked,
        state.client,
      );
      // Not from the cache alone after all: the view moved since the
      // change, and the resource is about to read where it moved to.
      if (!read.cacheOnly) return;
      read.answer.then(
        (value) =>
          fresh.set({ after, snapshot: { status: "resolved", value } }),
        (failure: unknown) => {
          // Only a failure on a live client counts, as in the loader.
          if (untracked(tscache.state) !== state) return;
          const error =
            failure instanceof Error ? failure : new Error(String(failure));
          fresh.set({ after, snapshot: { status: "error", error } });
        },
      );
    },
  });
  inject(DestroyRef).onDestroy(() => views.dispose());
  const live = resource({
    params: () => {
      const asked = range();
      if (asked === undefined) return undefined;
      const state = tscache.state();
      if (state.status === "connecting") throw ResourceParamsStatus.LOADING;
      if (state.status === "failed") throw state.error;
      return { client: state.client, range: asked, changed: changed() };
    },
    // A lost worker's client emits workerLost before this get's rejection is
    // handled, so by then the state, hence the params, have changed, and
    // resource() drops the rejection with the request it belongs to.
    loader: ({ params }) => {
      loaded = { client: params.client, range: params.range };
      return views.read(
        tscache.cache(params.client, config),
        params.range,
        params.client,
      ).answer;
    },
  });
  return withPreviousValue(live, tscache.takeServerRead(config)?.result, fresh);
}
