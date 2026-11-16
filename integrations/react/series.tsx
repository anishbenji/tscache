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
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  ChangeHold,
  ChangeWatch,
  cacheOnlyAfter,
  type Reread,
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
 * deferred like the range so the previous answer stays on screen. The
 * subscription starts in an effect, after the first read went out, so it
 * reads the cache alone once more when it starts, and again when a new
 * range commits: a change in between shows too.
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
  const view = useId();
  // The newest read this view started, set while rendering: a change
  // holds against it, and a cache-only read waits for its answer
  // (shared/changes.ts, cacheOnlyAfter).
  const newest = useRef<Read | undefined>(undefined);
  const watching = useRef<ChangeWatch | undefined>(undefined);
  // Holds a cache-only change while the newest read fetches, and releases
  // it through the frame once that read settled (shared/changes.ts): the
  // same piece ViewReads uses, so the rule lives in one place.
  const holding = useRef<ChangeHold | undefined>(undefined);
  holding.current ??= new ChangeHold(() => watching.current?.schedule("cache"));
  const hold = holding.current;
  const latest = useChanges(connection, snapshot, cache, start, end, {
    hold,
    watching,
  });
  // Deferred like the inputs above: a change's read suspends in a
  // background render, never back to the Suspense fallback.
  const recorded = useDeferredValue(latest);
  // A change applies only to the view it was recorded for: the same range,
  // the same client (a replaced worker is a new view) and the same cache.
  const configKey = keyOf(cache);
  const over = (c: Changed) =>
    c.start === start &&
    c.end === end &&
    c.owner === snapshot &&
    c.config === configKey
      ? c
      : UNCHANGED;

  let read: Read | undefined;
  if (connection !== null) {
    // Started for the newest change, even while the deferred render below
    // still shows an older one; each render finds it again by its key.
    const started = readFor(connection, snapshot, cache, start, end, {
      changed: over(latest),
      base: newest.current,
      view,
    });
    newest.current = started;
    if (started !== undefined) hold.started(started);
    read = readFor(connection, snapshot, cache, start, end, {
      changed: over(recorded),
      base: undefined,
      view,
    });
  }
  useEffect(() => read?.show(), [read]);

  if (read !== undefined) return use(read.answer);
  if (snapshot.status === "failed") throw snapshot.error;
  return serverAnswer(seeds, cache, start, end);
}

/** How often the cache changed over a range, and how the last change asks to read. */
interface Changed {
  n: number;
  how: Reread;
  start: number;
  end: number;
  /** The connection state the change was heard on: its client. */
  owner: Snapshot | undefined;
  /** The cache's config, as `keyOf` gives it. */
  config: string;
}

const UNCHANGED: Changed = {
  n: 0,
  how: "fetch",
  start: 0,
  end: 0,
  owner: undefined,
  config: "",
};

/**
 * Follows the connected client's cache for the range on screen; returns
 * the changes so far, with the view they were over (the caller ignores
 * them for another view, whose read fetches anyway). `hold` decides
 * whether a change waits for the newest read (shared/changes.ts); this
 * hook keeps no hold of its own. The subscription follows the config by
 * its value (`keyOf`), so an equal config made on every render does not
 * subscribe again.
 */
function useChanges(
  connection: Connection | null,
  snapshot: Snapshot,
  config: CacheConfig,
  start: number,
  end: number,
  {
    hold,
    watching,
  }: { hold: ChangeHold; watching: { current: ChangeWatch | undefined } },
): Changed {
  const [changed, setChanged] = useState(UNCHANGED);
  const shown = useRef<Range | undefined>(undefined);
  const current = useRef(config);
  current.current = config;
  const configKey = keyOf(config);
  useEffect(() => {
    // An event that arrived before this commit was judged against the
    // previous range: read the new one from the cache once more.
    if (shown.current !== undefined) watching.current?.schedule("cache");
    shown.current = { start, end };
  }, [start, end, watching]);
  useEffect(() => {
    if (connection === null || snapshot.status !== "connected") return;
    const watch: ChangeWatch = new ChangeWatch({
      shown: () => shown.current,
      reread: (how) => {
        const range = shown.current;
        if (range === undefined || hold.holds(how)) return;
        const view = { owner: snapshot, config: configKey, ...range };
        setChanged((previous) => ({ n: previous.n + 1, how, ...view }));
      },
      catchUp: true,
    });
    watching.current = watch;
    let live = true;
    connection.cache(snapshot.client, current.current).then(
      (cache) => {
        if (live) watch.follow(cache);
      },
      // The read through the same cache reports what failed.
      () => {},
    );
    return () => {
      live = false;
      watch.dispose();
      if (watching.current === watch) watching.current = undefined;
    };
  }, [connection, snapshot, configKey, hold, watching]);
  return changed;
}

/**
 * The read a render suspends on: from the snapshot's client, or from the
 * next client while the connection connects. A render that suspended while
 * connecting finds the same read once connected (see clientOf), since
 * React replays a suspended render expecting the same promise.
 */
function readFor(
  connection: Connection,
  snapshot: Snapshot,
  config: CacheConfig,
  start: number,
  end: number,
  after: After,
): Read | undefined {
  if (snapshot.status === "connected") {
    const client = promiseOf(snapshot.client);
    return readOf(connection, client, config, start, end, after);
  }
  if (snapshot.status === "connecting") {
    const client = clientOf(connection);
    return readOf(connection, client, config, start, end, after);
  }
  return undefined;
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
 * How long a settled read that no mounted component shows stays cached.
 * A suspended render commits only once every read it waits on has settled,
 * and React reports no render it abandons; this outlasts that wait, so
 * each retry finds the promise it suspended on.
 */
const KEEP_MS = 30_000;

/**
 * One client's read of one range. A pending read, and a read a mounted
 * component shows, stay cached; any other is dropped KEEP_MS after it
 * settled or was last shown. Nothing is dropped during a render.
 */
class Read {
  readonly answer: Promise<GetResult>;
  /** Whether it fetches; a cache-only read holds no change (ChangeHold). */
  readonly fetching: boolean;
  readonly #reads: Map<string, Read>;
  readonly #key: string;
  #shown = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    answer: Promise<GetResult>,
    reads: Map<string, Read>,
    key: string,
    cacheOnly: boolean,
  ) {
    this.answer = answer;
    this.fetching = !cacheOnly;
    this.#reads = reads;
    this.#key = key;
    const settled = () => this.#expire();
    answer.then(settled, settled);
  }

  /** Keeps the read while a mounted component shows it; returns the release. */
  show(): () => void {
    this.#shown++;
    clearTimeout(this.#expiry);
    return () => {
      this.#shown--;
      this.#expire();
    };
  }

  #expire(): void {
    if (this.#shown > 0) return;
    clearTimeout(this.#expiry);
    this.#expiry = setTimeout(() => {
      if (this.#reads.get(this.#key) === this) this.#reads.delete(this.#key);
    }, KEEP_MS);
  }
}

const byName = ([a]: [string, unknown], [b]: [string, unknown]) =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * A config's whole value as a key, the same however its properties are
 * ordered. Equal configs share their reads; one that conflicts with
 * another of the same id gets reads of its own, which reach the client and
 * fail with its ConfigError. Computed on each render, so a config changed
 * in place is judged afresh.
 */
function keyOf({ fields, ...rest }: CacheConfig): string {
  return JSON.stringify([
    Object.entries(rest).sort(byName),
    Object.entries(fields).sort(byName),
  ]);
}

/** What a read after a change depends on. */
interface After {
  /** The change it reads after; UNCHANGED for a plain read. */
  changed: Changed;
  /** The view's newest read before it, whose answer a cache-only read waits for. */
  base: Read | undefined;
  /** The view (useId): reads after a change are the view's own. */
  view: string;
}

const PLAIN: After = { changed: UNCHANGED, base: undefined, view: "" };

/** The reads made through each client's promise, by config and range. */
const readsOf = new WeakMap<Promise<TscacheClient>, Map<string, Read>>();

/**
 * The read of a range through `client`: the same object on every render
 * that asks for it, so `use` sees one promise. A new client starts with no
 * reads. Each change over the range is a read of its own and of its view,
 * from the cache alone unless the change asked for a fetch; a cache-only
 * read starts once `base` has answered and keeps its failure labels.
 */
function readOf(
  connection: Connection,
  client: Promise<TscacheClient>,
  config: CacheConfig,
  start: number,
  end: number,
  { changed, base, view }: After = PLAIN,
): Read {
  let reads = readsOf.get(client);
  if (reads === undefined) {
    reads = new Map();
    readsOf.set(client, reads);
  }
  const after = changed.n === 0 ? "" : ` ${view}:${changed.n}`;
  const key = `${keyOf(config)} ${start} ${end}${after}`;
  let read = reads.get(key);
  if (read === undefined) {
    const cacheOnly = changed.n > 0 && changed.how === "cache";
    const get = () => answer(connection, client, config, start, end, cacheOnly);
    const promise = cacheOnly
      ? cacheOnlyAfter(base?.answer, get, config.interval)
      : get();
    read = new Read(promise, reads, key, cacheOnly);
    reads.set(key, read);
  }
  return read;
}

async function answer(
  connection: Connection,
  awaited: Promise<TscacheClient>,
  config: CacheConfig,
  start: number,
  end: number,
  cacheOnly: boolean,
): Promise<GetResult> {
  const client = await awaited;
  try {
    const cache = await connection.cache(client, config);
    return await cache.get({ start, end }, { cacheOnly });
  } catch (error) {
    const { state } = connection;
    if (state.status === "connected" && state.client === client) throw error;
    // The worker was lost: the client rejected what was pending, and the
    // connection is replacing it. The next client answers instead.
    return readOf(connection, clientOf(connection), config, start, end).answer;
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
