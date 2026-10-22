// tscache in React: a provider for the app's one connection
// (shared/connection.ts) and a hook that suspends until the cache answers
// for a range. The connection is created outside React, where app-lifetime
// resources belong, so StrictMode's doubled effects never open a second
// client. The hook defers its inputs (the connection's state, the cache and
// the range), so a new client, cache or range loads in a background render
// while the previous answer stays on screen. Without that, a reconnect
// would bring back the Suspense fallback: a store update cannot be a
// transition.

import {
  createContext,
  type ReactNode,
  use,
  useDeferredValue,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import type { CacheConfig, GetResult, Range, TscacheClient } from "tscache";
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
 * first answer shows the Suspense fallback. Pass `config` as a constant.
 * Only the latest range's answer shows: React drops a background render
 * that a newer range overtook. A failed connection, or a read that failed
 * on a live client, throws to the nearest error boundary; a read cut short
 * by a lost worker is asked again of the client replacing it.
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

  const read =
    connection !== null && snapshot.status === "connected"
      ? readOf(connection, snapshot.client, cache, start, end)
      : undefined;
  useEffect(() => {
    if (read === undefined) return;
    read.shown++;
    return () => {
      read.shown--;
    };
  }, [read]);

  if (read !== undefined) return use(read.answer);
  if (connection === null || snapshot.status === "server") {
    return serverAnswer(seeds, cache, start, end);
  }
  if (snapshot.status === "failed") throw snapshot.error;
  const client = use(clientOf(connection));
  return use(readOf(connection, client, cache, start, end).answer);
}

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

/** How many answers that no mounted component shows a client keeps. */
const SPARE = 8;

interface Read {
  readonly answer: Promise<GetResult>;
  /** Mounted components showing the answer; while any does, it stays. */
  shown: number;
}

/** Each client's reads by cache and range, least recently used first. */
const readsOf = new WeakMap<TscacheClient, Map<string, Read>>();

/**
 * `client`'s read of a range: the same object on every render that asks
 * for it, so `use` sees one promise. Answers no mounted component shows
 * are dropped beyond the SPARE used last; a new client starts with none.
 */
function readOf(
  connection: Connection,
  client: TscacheClient,
  config: CacheConfig,
  start: number,
  end: number,
): Read {
  let reads = readsOf.get(client);
  if (reads === undefined) {
    reads = new Map();
    readsOf.set(client, reads);
  }
  const key = `${config.id} ${start} ${end}`;
  const read = reads.get(key) ?? {
    answer: answer(connection, client, config, start, end),
    shown: 0,
  };
  reads.delete(key);
  reads.set(key, read);
  let spare = 0;
  for (const other of reads.values()) if (other.shown === 0) spare++;
  for (const [key, other] of reads) {
    if (spare <= SPARE) break;
    if (other.shown === 0) {
      reads.delete(key);
      spare--;
    }
  }
  return read;
}

async function answer(
  connection: Connection,
  client: TscacheClient,
  config: CacheConfig,
  start: number,
  end: number,
): Promise<GetResult> {
  try {
    const cache = await connection.cache(client, config);
    return await cache.get({ start, end });
  } catch (error) {
    const { state } = connection;
    if (state.status === "connected" && state.client === client) throw error;
    // The worker was lost: the client rejected what was pending, and the
    // connection is replacing it. The next client answers instead.
    const next = await clientOf(connection);
    return readOf(connection, next, config, start, end).answer;
  }
}

/** One promise per connecting connection, for every render while it connects. */
const nextClients = new WeakMap<Connection, Promise<TscacheClient>>();

/** The connection's client, now or once it connects; rejects if it fails to. */
function clientOf(connection: Connection): Promise<TscacheClient> {
  const { state } = connection;
  if (state.status === "connected") return Promise.resolve(state.client);
  if (state.status === "failed") return Promise.reject(state.error);
  let next = nextClients.get(connection);
  if (next === undefined) {
    next = new Promise((resolve, reject) => {
      const unsubscribe = connection.subscribe(() => {
        const now = connection.state;
        if (now.status === "connecting") return;
        unsubscribe();
        nextClients.delete(connection);
        if (now.status === "connected") resolve(now.client);
        else reject(now.error);
      });
    });
    nextClients.set(connection, next);
  }
  return next;
}
