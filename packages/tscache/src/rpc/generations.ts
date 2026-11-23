/**
 * The SharedWorkers of an origin, to each other (docs/architecture.md §4.7,
 * §4.10.7; N127, N128, N135, N140). They share one `BroadcastChannel`: a
 * worker announces itself there once, so that workers of different
 * generations find each other and the lower-ranked one is superseded, and
 * every hosting posts its `clearAll` there. Nothing of it crosses a port.
 *
 * This module is the SharedWorker's part; the channel itself, and the post
 * of the hostings that only post, are in `workers-channel.ts`, so that a
 * page's in-process hosting does not carry the rank and the announcements.
 */

import type { ClearAll, WorkersChannel } from "./workers-channel";

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
  /** The SharedWorker's name: its generation key (N125). */
  name?: string;
  /** Its `performance.timeOrigin`. */
  startedAt: number;
}

/**
 * The messages. One may come from any release, so an unknown `t` or `v`,
 * or a field of the wrong type, makes it one to ignore.
 */
type Announce = Announcement & { t: "announce" | "present"; v: 1 };

interface Version {
  /** Major, minor and patch as digit strings, compared by `compareNumeric`. */
  core: string[];
  /** The prerelease identifiers; undefined for a release. */
  pre: string[] | undefined;
}

/**
 * A semantic version, read leniently: each core part is its leading digits,
 * and a part without any counts as 0. The digits stay a string, so no part
 * is rounded (gate round 6 of step 135).
 */
function versionOf(lib: string): Version {
  const version = lib.split("+", 1)[0] ?? "";
  const dash = version.indexOf("-");
  const core = (dash < 0 ? version : version.slice(0, dash))
    .split(".")
    .map((part) => /^\d+/.exec(part)?.[0] ?? "0");
  return {
    core,
    pre: dash < 0 ? undefined : version.slice(dash + 1).split("."),
  };
}

const NUMERIC = /^\d+$/;

/**
 * Two numbers written in digits, by value, exactly at any size (semver
 * §11): a `Number` rounds above 2^53. Every numeric part of a version goes
 * through here, core and prerelease alike. Leading zeros do not count;
 * without them the longer one is the larger, and of equal length the
 * digits decide.
 */
function compareNumeric(a: string, b: string): number {
  const x = a.replace(/^0+(?=\d)/, "");
  const y = b.replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x === y ? 0 : x < y ? -1 : 1;
}

/** Semver precedence of two prerelease identifiers. */
function compareIdentifiers(a: string, b: string): number {
  const an = NUMERIC.test(a);
  const bn = NUMERIC.test(b);
  if (an && bn) return compareNumeric(a, b);
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
    const by = compareNumeric(x.core[i] ?? "0", y.core[i] ?? "0");
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
 * Whether two workers are of one generation (N140): the same script and
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
 * Whether `a` ranks above `b` (N128): the higher library version, then the
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

/**
 * The announcement of an `announce` or `present`, or undefined if malformed:
 * a required field missing or of the wrong type, or an optional key present
 * without a string, `undefined` included, which structured clone keeps (read
 * as absent, a bad `fetcher` would make the sender another generation).
 */
function announcementOf(m: Record<string, unknown>): Announcement | undefined {
  const { id, lib, url, fetcher, name, startedAt } = m;
  if (
    typeof id !== "string" ||
    typeof lib !== "string" ||
    typeof url !== "string" ||
    typeof startedAt !== "number" ||
    !Number.isFinite(startedAt) ||
    ("fetcher" in m && typeof fetcher !== "string") ||
    ("name" in m && typeof name !== "string")
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
 * worker of this generation runs under another key (N140).
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

  /**
   * A later `init` loaded the worker's first fetcher module, its first
   * naming none (an unnamed worker): from now on its `present` answers and
   * its comparisons carry the module. Nothing is posted, as N127 has one
   * `announce` per worker, so a worker that was already running is not
   * compared again (a known limit, architecture §4.7).
   */
  fetcherLoaded(fetcher: string): void {
    if (this.#self.fetcher !== undefined) return;
    const fetcherUrl = resolved({ ...this.#self, fetcher });
    if (fetcherUrl !== undefined) {
      this.#self = { ...this.#self, fetcher: fetcherUrl };
    }
  }

  /** Posts a `clearAll` of this worker, or its relay of another's (N135). */
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
