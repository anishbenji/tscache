/**
 * The SharedWorkers of an origin, to each other (docs/architecture.md §4.7,
 * §4.10.7; N108, N109, N116, N121). They share one `BroadcastChannel`: a
 * worker announces itself there once, so that workers of different
 * generations find each other and the lower-ranked one is superseded, and
 * every hosting posts its `clearAll` there. Nothing of it crosses a port.
 *
 * No DOM references: the channel is looked up at call time, and a realm
 * without `BroadcastChannel` simply has none.
 */

import { randomId } from "../random-id";

/** The channel's name; the origin's, so the same partition as the database. */
const WORKERS_CHANNEL = "tscache-workers";

/** The part of `BroadcastChannel` used here. */
export interface WorkersChannel {
  postMessage(message: unknown): void;
  addEventListener(
    type: "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
  close(): void;
}

/** What a worker says of itself; `fetcher` once its first `init` is done. */
export interface Announcement {
  /** The worker's lifetime lock name (N32), or a random id. */
  id: string;
  /** Its `LIB_VERSION`. */
  lib: string;
  /** Its script URL (`self.location.href`), so its build. */
  url: string;
  /** The fetcher module it loaded, resolved against `url`; absent when none. */
  fetcher?: string;
  /** The SharedWorker's name: its generation key (N106). */
  name?: string;
  /** Its `performance.timeOrigin`. */
  startedAt: number;
}

/**
 * The messages. One may come from any release, so an unknown `t` or `v`,
 * or a field of the wrong type, makes it one to ignore.
 */
type Announce = Announcement & { t: "announce" | "present"; v: 1 };
type ClearAll = { t: "clearAll"; v: 1; id: string; clear: string };

/** The origin's workers channel, or undefined without `BroadcastChannel`. */
export function openWorkersChannel(): WorkersChannel | undefined {
  const Channel = (
    globalThis as { BroadcastChannel?: new (name: string) => WorkersChannel }
  ).BroadcastChannel;
  if (typeof Channel !== "function") return undefined;
  try {
    return new Channel(WORKERS_CHANNEL);
  } catch {
    return undefined;
  }
}

interface Version {
  core: number[];
  /** The prerelease identifiers; undefined for a release. */
  pre: string[] | undefined;
}

/** A semantic version, read leniently: what is not a number counts as 0. */
function versionOf(lib: string): Version {
  const version = lib.split("+", 1)[0] ?? "";
  const dash = version.indexOf("-");
  const core = (dash < 0 ? version : version.slice(0, dash))
    .split(".")
    .map((part) => {
      const n = Number.parseInt(part, 10);
      return Number.isNaN(n) ? 0 : n;
    });
  return {
    core,
    pre: dash < 0 ? undefined : version.slice(dash + 1).split("."),
  };
}

const NUMERIC = /^\d+$/;

/** Semver precedence of two prerelease identifiers. */
function compareIdentifiers(a: string, b: string): number {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an !== bn) return an ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Semver precedence of two prerelease lists; a release (none) is above any. */
function comparePrereleases(
  a: string[] | undefined,
  b: string[] | undefined,
): number {
  if (a === undefined || b === undefined) {
    return Number(a === undefined) - Number(b === undefined);
  }
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const by = compareIdentifiers(a[i] as string, b[i] as string);
    if (by !== 0) return by;
  }
  // The shorter list of otherwise equal identifiers is the lower one.
  return a.length - b.length;
}

/**
 * Semver precedence: negative when `a` is the lower version. `0.10.0` is
 * above `0.9.0`, and a prerelease below its release.
 */
function compareLib(a: string, b: string): number {
  const x = versionOf(a);
  const y = versionOf(b);
  for (let i = 0; i < 3; i++) {
    const by = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (by !== 0) return by;
  }
  return comparePrereleases(x.pre, y.pre);
}

/** A fetcher string as a URL against its worker's script, when it is one. */
function resolved(worker: Announcement): string | undefined {
  if (worker.fetcher === undefined) return undefined;
  try {
    return new URL(worker.fetcher, worker.url).href;
  } catch {
    return worker.fetcher;
  }
}

/**
 * Whether two workers are of one generation (N121): the same script and
 * library, and the same fetcher module or one of them without a fetcher.
 * Such workers never supersede each other, whatever their ranks: a reload
 * could not join them.
 */
export function sameGeneration(a: Announcement, b: Announcement): boolean {
  if (a.url !== b.url || a.lib !== b.lib) return false;
  const fa = resolved(a);
  const fb = resolved(b);
  return fa === undefined || fb === undefined || fa === fb;
}

/**
 * Whether `a` ranks above `b` (N109): the higher library version, then the
 * later start, then the greater id. A strict total order on workers with
 * different ids, so both sides of a pair compute the same answer.
 */
export function outranks(a: Announcement, b: Announcement): boolean {
  const byLib = compareLib(a.lib, b.lib);
  if (byLib !== 0) return byLib > 0;
  if (a.startedAt !== b.startedAt) return a.startedAt > b.startedAt;
  return a.id > b.id;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** The announcement of an `announce` or `present`, or undefined if malformed. */
function announcementOf(m: Record<string, unknown>): Announcement | undefined {
  const { id, lib, url, fetcher, name, startedAt } = m;
  if (
    typeof id !== "string" ||
    typeof lib !== "string" ||
    typeof url !== "string" ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt)
  ) {
    return undefined;
  }
  const worker: Announcement = { id, lib, url, startedAt };
  if (typeof fetcher === "string") worker.fetcher = fetcher;
  if (typeof name === "string") worker.name = name;
  return worker;
}

// As client/dev.ts reads it: bundlers replace the exact text.
declare const process: { env: { NODE_ENV?: string } };

/**
 * One console.warn, in a development build of the worker, that a second
 * worker of this generation runs under another key (N121).
 */
function warnTwoKeys(own: string | undefined, other: string | undefined): void {
  try {
    if (process.env.NODE_ENV === "production") return;
  } catch {
    return;
  }
  console.warn(
    `tscache: two SharedWorkers of one deploy are running, under the keys "${own ?? ""}" and "${other ?? ""}". They share no cache and both persist. Pass the same fetcher module string on every page (a page without a fetcher counts as another key); printed in development builds only.`,
  );
}

export interface GenerationHooks {
  /**
   * A higher-ranked worker of another generation is running: this worker is
   * superseded. Called at most once, with that worker's `lib`.
   */
  superseded(lib: string): void;
  /** Another worker or hosting posted a `clearAll`, with this clear id. */
  clearAll(clearId: string): void;
}

/**
 * One SharedWorker's part in the channel. It listens from its construction,
 * which the entry does before it attaches any port, so no `clearAll` posted
 * later can miss a worker that then reads the disk (§4.10.7).
 */
export class Generations {
  readonly #channel: WorkersChannel;
  readonly #hooks: GenerationHooks;
  #self: Announcement;
  #announced = false;
  #superseded = false;
  #warned = false;

  constructor(
    channel: WorkersChannel,
    self: Omit<Announcement, "fetcher">,
    hooks: GenerationHooks,
  ) {
    this.#channel = channel;
    this.#self = self;
    this.#hooks = hooks;
    channel.addEventListener("message", (event) => this.#receive(event.data));
  }

  /**
   * The worker's first connection has completed `init`, so it knows its
   * fetcher: posts the one `announce`. From now on it answers the
   * `announce` of other workers and compares itself with them.
   */
  announce(fetcher: string | undefined): void {
    if (this.#announced) return;
    this.#announced = true;
    if (fetcher !== undefined) {
      const fetcherUrl = resolved({ ...this.#self, fetcher });
      if (fetcherUrl !== undefined) {
        this.#self = { ...this.#self, fetcher: fetcherUrl };
      }
    }
    this.#post({ ...this.#self, t: "announce", v: 1 });
  }

  /** Posts a `clearAll` of this worker, or its relay of another's (N116). */
  postClear(clearId: string): void {
    this.#post({ t: "clearAll", v: 1, id: this.#self.id, clear: clearId });
  }

  #post(message: Announce | ClearAll): void {
    try {
      this.#channel.postMessage(message);
    } catch {
      // A channel that fails reaches nobody; this worker goes on alone.
    }
  }

  #receive(data: unknown): void {
    const message = this.#foreign(data);
    if (message === undefined) return;
    if (message.t === "clearAll") {
      if (typeof message.clear === "string") {
        this.#hooks.clearAll(message.clear);
      }
    } else if (message.t === "announce" || message.t === "present") {
      this.#heard(message, message.t === "announce");
    }
  }

  /** A version 1 message that another worker sent, or undefined. */
  #foreign(data: unknown): Record<string, unknown> | undefined {
    if (!isObject(data) || data.v !== 1) return undefined;
    const own = typeof data.id !== "string" || data.id === this.#self.id;
    return own ? undefined : data;
  }

  /** Another worker's `announce`, answered with one `present`, or its `present`. */
  #heard(message: Record<string, unknown>, answer: boolean): void {
    const other = announcementOf(message);
    // Before its own announce a worker does not know its fetcher: its
    // announce will bring a `present` from every worker running then.
    if (other === undefined || !this.#announced) return;
    if (answer) this.#post({ ...this.#self, t: "present", v: 1 });
    this.#compare(other);
  }

  #compare(other: Announcement): void {
    if (sameGeneration(this.#self, other)) {
      if (other.name !== this.#self.name && !this.#warned) {
        this.#warned = true;
        warnTwoKeys(this.#self.name, other.name);
      }
      return;
    }
    if (this.#superseded || !outranks(other, this.#self)) return;
    this.#superseded = true;
    this.#hooks.superseded(other.lib);
  }
}

/**
 * The `post` of a hosting that only posts its `clearAll` (N116, N119): the
 * dedicated worker and the in-process hosting. It opens the channel at a
 * clear's first post and closes it after its second, so a page that never
 * calls `clearAll` never holds a channel. Undefined in a realm without
 * `BroadcastChannel`.
 */
export function clearPoster(): ((clearId: string) => void) | undefined {
  const scope = globalThis as { BroadcastChannel?: unknown };
  if (typeof scope.BroadcastChannel !== "function") return undefined;
  const id = randomId();
  const open = new Map<string, WorkersChannel>();
  return (clearId) => {
    const held = open.get(clearId);
    const channel = held ?? openWorkersChannel();
    if (channel === undefined) return;
    if (held === undefined) open.set(clearId, channel);
    else open.delete(clearId);
    const message: ClearAll = { t: "clearAll", v: 1, id, clear: clearId };
    try {
      channel.postMessage(message);
    } finally {
      if (held !== undefined) channel.close();
    }
  };
}
