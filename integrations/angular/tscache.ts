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
} from "@angular/core";
import type {
  CacheConfig,
  CacheHandle,
  GetResult,
  Range,
  TscacheClient,
} from "tscache";
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

/**
 * `source`, except that while it loads it goes on showing its last value,
 * or `initial` before it has one: Angular's withPreviousValue recipe
 * (angular.dev/guide/signals/resource, "Resource composition with
 * snapshots").
 */
function withPreviousValue<T>(source: Resource<T>, initial: T): Resource<T> {
  const snapshot = linkedSignal<ResourceSnapshot<T>, ResourceSnapshot<T>>({
    source: source.snapshot,
    computation: (next, previous) => {
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
 * that fails on a live client, is: `error()`.
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
  const live = resource({
    params: () => {
      const asked = range();
      if (asked === undefined) return undefined;
      const state = tscache.state();
      if (state.status === "connecting") throw ResourceParamsStatus.LOADING;
      if (state.status === "failed") throw state.error;
      return { client: state.client, range: asked };
    },
    // A lost worker's client emits workerLost before this get's rejection is
    // handled, so by then the state, hence the params, have changed, and
    // resource() drops the rejection with the request it belongs to.
    loader: async ({ params }) =>
      (await tscache.cache(params.client, config)).get(params.range),
  });
  return withPreviousValue(live, tscache.takeServerRead(config)?.result);
}
