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
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { ChangeWatch, type Reread } from "../shared/changes";
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
 * from the cache alone, or with a fetch after a change that wrote nothing.
 * The subscription starts in an effect, after the first read went out, so
 * it reads the cache alone once more when it starts: a change in between
 * shows too.
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
  const changed = useChanges(connection, snapshot, cache, start, end);

  const read =
    connection === null
      ? undefined
      : readFor(connection, snapshot, cache, start, end, changed);
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
}

const UNCHANGED: Changed = { n: 0, how: "fetch", start: 0, end: 0 };

/**
 * Follows the connected client's cache for the range on screen; returns
 * the changes so far over that range (none after the range moved, whose
 * read fetches anyway).
 */
function useChanges(
  connection: Connection | null,
  snapshot: Snapshot,
  config: CacheConfig,
  start: number,
  end: number,
): Changed {
  const [changed, setChanged] = useState(UNCHANGED);
  const shown = useRef<Range | undefined>(undefined);
  useEffect(() => {
    shown.current = { start, end };
  }, [start, end]);
  useEffect(() => {
    if (connection === null || snapshot.status !== "connected") return;
    const watch = new ChangeWatch({
      shown: () => shown.current,
      reread: (how) => {
        const range = shown.current;
        if (range === undefined) return;
        setChanged((previous) => ({ n: previous.n + 1, how, ...range }));
      },
      catchUp: true,
    });
    let live = true;
    connection.cache(snapshot.client, config).then(
      (cache) => {
        if (live) watch.follow(cache);
      },
      // The read through the same cache reports what failed.
      () => {},
    );
    return () => {
      live = false;
      watch.dispose();
    };
  }, [connection, snapshot, config]);
  return changed.start === start && changed.end === end ? changed : UNCHANGED;
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
  changed: Changed,
): Read | undefined {
  if (snapshot.status === "connected") {
    const client = promiseOf(snapshot.client);
    return readOf(connection, client, config, start, end, changed);
  }
  if (snapshot.status === "connecting") {
    const client = clientOf(connection);
    return readOf(connection, client, config, start, end, changed);
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
  readonly #reads: Map<string, Read>;
  readonly #key: string;
  #shown = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    answer: Promise<GetResult>,
    reads: Map<string, Read>,
    key: string,
  ) {
    this.answer = answer;
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

/** The reads made through each client's promise, by config and range. */
const readsOf = new WeakMap<Promise<TscacheClient>, Map<string, Read>>();

/**
 * The read of a range through `client`: the same object on every render
 * that asks for it, so `use` sees one promise. A new client starts with no
 * reads. Each change over the range is a read of its own, from the cache
 * alone unless the change asked for a fetch.
 */
function readOf(
  connection: Connection,
  client: Promise<TscacheClient>,
  config: CacheConfig,
  start: number,
  end: number,
  changed: Changed = UNCHANGED,
): Read {
  let reads = readsOf.get(client);
  if (reads === undefined) {
    reads = new Map();
    readsOf.set(client, reads);
  }
  const key = `${keyOf(config)} ${start} ${end} ${changed.n}`;
  let read = reads.get(key);
  if (read === undefined) {
    const cacheOnly = changed.n > 0 && changed.how === "cache";
    const promise = answer(connection, client, config, start, end, cacheOnly);
    read = new Read(promise, reads, key);
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
