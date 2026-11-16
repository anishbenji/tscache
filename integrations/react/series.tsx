// tscache in React: a provider for the app's one connection
// (shared/connection.ts) and a hook that suspends until the cache answers
// for a range. The connection is created outside React, where app-lifetime
// resources belong, so StrictMode's doubled effects never open a second
// client. The hook defers its inputs (the connection's state, the cache and
// the range), so a new client, cache or range loads in a background render
// while the previous answer stays on screen. Without that, a reconnect
// would bring back the Suspense fallback: a store update cannot be a
// transition. A change to the cache over the range on screen, from any
// tab, reads it again, at most once per frame (shared/changes.ts).

import type {
  CacheConfig,
  CacheHandle,
  GetResult,
  Range,
  TscacheClient,
} from "@anishbenji/tscache";
import {
  createContext,
  type ReactNode,
  use,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type Frame,
  nextFrame,
  type ReadMode,
  ViewReads,
} from "../shared/changes";
import type { Connection, ConnectionState, Seed } from "../shared/connection";

interface Source {
  connection: Connection | null;
  seeds: readonly Seed[];
}

const NO_SEEDS: readonly Seed[] = [];
const SourceContext = createContext<Source>({
  connection: null,
  seeds: NO_SEEDS,
});

export interface TscacheProviderProps {
  /**
   * The app's connection: created once, before the first render, and
   * disposed after the root unmounts. Null on the server, which renders
   * the seeds alone.
   */
  connection: Connection | null;
  /**
   * What the server read. The server's render and the browser's hydration
   * render both show it, so their markup matches; the browser passes the
   * same seeds to `connect`, so its cache starts from them.
   */
  seeds?: readonly Seed[];
  children?: ReactNode;
}

/** Gives every useSeries below it the app's connection and the server's reads. */
export function TscacheProvider({
  connection,
  seeds = NO_SEEDS,
  children,
}: TscacheProviderProps) {
  const source = useMemo(() => ({ connection, seeds }), [connection, seeds]);
  return <SourceContext value={source}>{children}</SourceContext>;
}

/**
 * What a render reads from: "server" in the server's render and the
 * browser's hydration render, which show the seeds; else the connection.
 */
type Snapshot = ConnectionState | { readonly status: "server" };
const SERVER: Snapshot = { status: "server" };
const server = (): Snapshot => SERVER;
const unsubscribed = () => () => {};

/**
 * The cache's answer for `range`, suspending until there is one; only a
 * first answer shows the Suspense fallback. Pass `config` as a constant,
 * and keep `range` in state: a range computed while rendering, from
 * Date.now() say, differs on every retry and never settles. Only the
 * latest range's answer shows: React drops a background render
 * that a newer range overtook. A failed connection, or a read that failed
 * on a live client, throws to the nearest error boundary; a read cut short
 * by a lost worker is asked again of the client replacing it.
 *
 * A change to the cache over the range reads it again (architecture §2.7):
 * from the cache alone, or with a fetch after a change that wrote nothing,
 * in a background render, so the previous answer stays on screen. Each
 * range, client and cache the component shows is a view of its own (see
 * View): it follows its cache from before its first read, which fetches,
 * and reads again only while the component shows it.
 */
export function useSeries(config: CacheConfig, range: Range): GetResult {
  const { connection, seeds } = use(SourceContext);
  const live = useSyncExternalStore(
    connection?.subscribe ?? unsubscribed,
    connection === null ? server : () => connection.state,
    server,
  );
  const snapshot = useDeferredValue(live);
  const cache = useDeferredValue(config);
  const start = useDeferredValue(range.start);
  const end = useDeferredValue(range.end);
  // The view this component shows, set when it commits. A render for the
  // same client, cache and range finds it here; any other is a move.
  const shown = useRef<View | undefined>(undefined);
  const view =
    connection === null
      ? undefined
      : viewFor(connection, snapshot, cache, start, end, shown.current);
  const newest = useSyncExternalStore(
    view?.subscribe ?? unsubscribed,
    () => view?.newest,
    () => view?.newest,
  );
  // Deferred like the inputs above: a change's read suspends in a
  // background render, never back to the Suspense fallback.
  const read = useDeferredValue(newest);
  useEffect(() => {
    if (view === undefined) return;
    shown.current = view;
    return view.show();
  }, [view]);

  if (read !== undefined) return use(read);
  if (snapshot.status === "failed") throw snapshot.error;
  return serverAnswer(seeds, cache, start, end);
}

/**
 * The view a render reads through: the one the component shows, when the
 * render is for the same client, cache and range; else the view of a move
 * (or of a first mount), found again by every retry of that render. While
 * the connection connects it is the next client's: a render that suspended
 * while connecting finds the same view once connected (see clientOf).
 */
function viewFor(
  connection: Connection,
  snapshot: Snapshot,
  config: CacheConfig,
  start: number,
  end: number,
  shown: View | undefined,
): View | undefined {
  if (snapshot.status !== "connected" && snapshot.status !== "connecting") {
    return undefined;
  }
  const client =
    snapshot.status === "connected"
      ? promiseOf(snapshot.client)
      : clientOf(connection);
  const what = whatOf(config, start, end);
  if (shown?.is(client, what) === true) return shown;
  const key = shown === undefined ? what : shown.moveTo(what);
  return viewOf(connection, client, config, start, end, key);
}

/**
 * The server's read of the cache `config` names, for the server's render
 * and the browser's hydration render. Matched by cache id, judging
 * nothing: whether `config` fits the cache is the client's call, and the
 * browser's client makes it against the cache opened with the seed's
 * config, so a conflicting config fails there with ConfigError.
 */
function serverAnswer(
  seeds: readonly Seed[],
  config: CacheConfig,
  start: number,
  end: number,
): GetResult {
  const read = seeds.find((seed) => seed.config.id === config.id)?.read;
  if (read?.range.start !== start || read.range.end !== end) {
    throw new Error(
      `useSeries has no connection and no server read of ${config.id} from ${start} to ${end}; check the TscacheProvider above it`,
    );
  }
  return read.result;
}

/**
 * How long a view that no mounted component shows is kept, from when its
 * newest read settled or, if later, from when it was last shown. A
 * suspended render commits only once every read it waits on has settled,
 * and React reports no render it abandons; this outlasts that wait, so
 * each retry finds the view it suspended on.
 */
const KEEP_MS = 30_000;

const byName = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * A config's whole value as a key, the same however its properties are
 * ordered. Equal configs are one cache to a view; one that conflicts with
 * another of the same id gets a view of its own, whose reads reach the
 * client and fail with its ConfigError. Computed on each render, so a
 * config changed in place is judged afresh.
 */
function keyOf({ fields, ...rest }: CacheConfig): string {
  return JSON.stringify([
    Object.entries(rest).sort(byName),
    Object.entries(fields).sort(byName),
  ]);
}

/** What a view is of, besides its client: the cache and the range, by value. */
function whatOf(config: CacheConfig, start: number, end: number): string {
  return `${keyOf(config)} ${start} ${end}`;
}

/** The views no component has committed yet, by client and key. */
const viewsOf = new WeakMap<Promise<TscacheClient>, Map<string, View>>();
let views = 0;

/** The view under `key` among `client`'s uncommitted ones, made if absent. */
function viewOf(
  connection: Connection,
  client: Promise<TscacheClient>,
  config: CacheConfig,
  start: number,
  end: number,
  key: string,
): View {
  let waiting = viewsOf.get(client);
  if (waiting === undefined) {
    waiting = new Map();
    viewsOf.set(client, waiting);
  }
  let view = waiting.get(key);
  if (view === undefined) {
    const of = { connection, client, config, range: { start, end } };
    view = new View(of, waiting, key);
    waiting.set(key, view);
  }
  return view;
}

/** What a view reads: one range of one cache, through one client. */
interface Of {
  connection: Connection;
  client: Promise<TscacheClient>;
  config: CacheConfig;
  range: Range;
}

/**
 * One view of the cache: one client, one cache and one range, which never
 * change, with the shared `ViewReads` every adapter uses (shared/changes.ts).
 * It follows the client's handle before its first read, which fetches;
 * every later read is a change's, so `ViewReads` reads the cache alone, or
 * fetches after a change that wrote nothing, holds a change while a fetch
 * is in flight, and keeps failure labels. React keeps only two things here.
 *
 * Where a view is found. A render must find the read it suspended on, and a
 * first mount that suspends keeps no state, so a view is made while
 * rendering and kept in a map: under its client, cache and range for a
 * first mount, and for a mounted component's move also under the view the
 * component shows, so each move is a view of its own. Once a component
 * commits with a view, the view leaves the map and belongs to that
 * component: no later mount or move finds it, so theirs fetch.
 *
 * When a view reads. Its changes are scheduled through a frame that waits
 * until a mounted component shows it. A view no component shows reads
 * nothing, so `newest` never changes under a suspended render, and it
 * misses nothing: it goes on following, and reads once when it is shown.
 * After KEEP_MS a view nobody shows stops following; shown again after
 * that, it starts afresh with a fetch.
 */
class View {
  /** The newest read's answer: what a render suspends on. */
  newest: Promise<GetResult>;
  readonly #of: Of;
  readonly #what: string;
  readonly #waiting: Map<string, View>;
  readonly #key: string;
  readonly #id = ++views;
  readonly #handle: Promise<CacheHandle>;
  readonly #listeners = new Set<() => void>();
  #reads: ViewReads;
  #shown = 0;
  /** Whether a component has committed with it. */
  #committed = false;
  /** Starts the frame of a change that waits for the view to be shown. */
  #parked: (() => void) | undefined;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #closed = false;

  constructor(of: Of, waiting: Map<string, View>, key: string) {
    this.#of = of;
    this.#what = whatOf(of.config, of.range.start, of.range.end);
    this.#waiting = waiting;
    this.#key = key;
    this.#handle = of.client.then((client) =>
      of.connection.cache(client, of.config),
    );
    this.#reads = this.#follow();
    this.newest = this.#read();
  }

  /** Whether it is the view of `what` through `client`. */
  is(client: Promise<TscacheClient>, what: string): boolean {
    return this.#of.client === client && this.#what === what;
  }

  /** The key of a move from this view to `what`: this view's alone. */
  moveTo(what: string): string {
    return `${what} from ${this.#id}`;
  }

  /** Calls `listener` when `newest` changes; for useSyncExternalStore. */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /**
   * A mounted component shows the view, from an effect: it is the
   * component's now, and reads the changes that waited. Returns the
   * release.
   *
   * The first time, it also reads the cache alone once. The view has
   * followed its cache since before its first read, so this read shows
   * nothing a change's read would not; it is kept because a new range's
   * commit has read the cache once more since pre-review 1 (PR-4), and
   * that is pinned by a test. It takes the place of a waiting cache-only
   * read, so a commit costs one such read either way.
   */
  show(): () => void {
    const first = !this.#committed;
    this.#committed = true;
    if (this.#waiting.get(this.#key) === this) this.#waiting.delete(this.#key);
    this.#shown++;
    clearTimeout(this.#expiry);
    if (this.#closed) {
      this.#closed = false;
      this.#reads = this.#follow();
      this.#reread();
    } else if (first) {
      this.#reread("cache");
    }
    const parked = this.#parked;
    this.#parked = undefined;
    parked?.();
    return () => {
      this.#shown--;
      this.#expire();
    };
  }

  #follow(): ViewReads {
    return new ViewReads({
      shown: () => this.#of.range,
      interval: this.#of.config.interval,
      reread: () => this.#reread(),
      frame: this.#frame,
    });
  }

  /**
   * The next frame at which a mounted component shows the view: a frame
   * that finds it shown by nobody waits for `show`.
   */
  readonly #frame: Frame = (callback) => {
    let cancel = () => {};
    const start = () => {
      cancel = nextFrame(() => {
        if (this.#shown > 0) callback();
        else park();
      });
    };
    const park = () => {
      this.#parked = start;
      cancel = () => {
        this.#parked = undefined;
      };
    };
    if (this.#shown > 0) start();
    else park();
    return () => cancel();
  };

  #reread(mode?: ReadMode): void {
    this.newest = this.#read(mode);
    for (const listener of this.#listeners) listener();
  }

  #read(mode?: ReadMode): Promise<GetResult> {
    const { client, range } = this.#of;
    const read = this.#reads.read(this.#handle, range, client, mode);
    const answer = this.#answer(read.answer);
    const settled = () => this.#expire();
    answer.then(settled, settled);
    return answer;
  }

  async #answer(read: Promise<GetResult>): Promise<GetResult> {
    const { connection, client, config, range } = this.#of;
    try {
      return await read;
    } catch (error) {
      // Rejects when the connection failed: there is no next client to ask.
      const awaited = await client;
      const { state } = connection;
      if (state.status === "connected" && state.client === awaited) throw error;
      // The worker was lost: the client rejected what was pending, and the
      // connection is replacing it. The next client's view answers instead:
      // the one the component's own render finds there, which is a move
      // from this view once a component has committed with it.
      const key = this.#committed ? this.moveTo(this.#what) : this.#key;
      const next = clientOf(connection);
      return viewOf(connection, next, config, range.start, range.end, key)
        .newest;
    }
  }

  /** Stops following KEEP_MS from now, unless a component shows the view. */
  #expire(): void {
    if (this.#shown > 0) return;
    clearTimeout(this.#expiry);
    this.#expiry = setTimeout(() => {
      if (this.#waiting.get(this.#key) === this)
        this.#waiting.delete(this.#key);
      this.#reads.dispose();
      this.#closed = true;
    }, KEEP_MS);
  }
}

/** The promise each client is known by. */
const promised = new WeakMap<TscacheClient, Promise<TscacheClient>>();
/** Each connecting connection's promise of its next client. */
const nextClients = new WeakMap<Connection, Promise<TscacheClient>>();

function promiseOf(client: TscacheClient): Promise<TscacheClient> {
  let promise = promised.get(client);
  if (promise === undefined) {
    promise = Promise.resolve(client);
    promised.set(client, promise);
  }
  return promise;
}

/**
 * The promise of the connection's client, or of its next one while it
 * connects, which rejects if the connection fails. The next client is
 * known by the promise that awaited it, so the reads made while
 * connecting are its reads.
 */
function clientOf(connection: Connection): Promise<TscacheClient> {
  const { state } = connection;
  if (state.status === "connected") return promiseOf(state.client);
  if (state.status === "failed") return Promise.reject(state.error);
  const waiting = nextClients.get(connection);
  if (waiting !== undefined) return waiting;
  const next = new Promise<TscacheClient>((resolve, reject) => {
    const unsubscribe = connection.subscribe(() => {
      const now = connection.state;
      if (now.status === "connecting") return;
      unsubscribe();
      nextClients.delete(connection);
      if (now.status === "failed") return reject(now.error);
      promised.set(now.client, next);
      resolve(now.client);
    });
  });
  nextClients.set(connection, next);
  return next;
}
