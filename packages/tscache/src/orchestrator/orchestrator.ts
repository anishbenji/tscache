/**
 * Fetch orchestration (docs/architecture.md §2.3, §2.5, §4.9): in front of
 * the Engine, turns a get's misses into deduplicated fetches, applies the
 * responses as authoritative puts, and reports what could not be fetched.
 */

import type { Engine } from "../engine/engine";
import { ConfigError, isAuthInvalidError, show, TscacheError } from "../errors";
import type { Evt, FetcherConfig } from "../rpc/protocol";
import type {
  Fetcher,
  FetchResponse,
  GetOptions,
  GetResult,
  MergeWarning,
  Miss,
  Range,
} from "../types";
import { AuthState } from "./auth";

type Outcome =
  | { kind: "applied"; warnings: MergeWarning[] }
  | { kind: "dropped" }
  | { kind: "auth" }
  | { kind: "failed"; error: { name: string; message: string } };

interface Settled {
  range: Range;
  outcome: Outcome;
}

const MAX = Number.MAX_SAFE_INTEGER;
const MIN = Number.MIN_SAFE_INTEGER;

function describe(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return {
      name: error.name,
      message:
        typeof error.message === "string" ? error.message : show(error.message),
    };
  }
  return { name: "Error", message: show(error) };
}

function keyOf(cacheId: string, range: Range): string {
  return `${cacheId}\u0000${range.start}\u0000${range.end}`;
}

function overlaps(a: Range, b: Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** `range` minus every range in `cuts`, in ms, as ascending pieces. */
function subtract(range: Range, cuts: Range[]): Range[] {
  let pieces: Range[] = [range];
  for (const cut of cuts) {
    pieces = pieces.flatMap((p) => {
      if (!overlaps(p, cut)) return [p];
      const out: Range[] = [];
      if (p.start < cut.start) out.push({ start: p.start, end: cut.start - 1 });
      if (p.end > cut.end) out.push({ start: cut.end + 1, end: p.end });
      return out;
    });
  }
  return pieces;
}

/**
 * The ranges to fetch for a result's uncached misses: adjacent misses merge,
 * and a miss abutting covered slots is extended by one interval into them
 * (locked: the one-point overlap aids range merge). Extensions never leave
 * the safe-integer domain.
 */
export function coalesce(
  misses: Range[],
  coverage: Range[],
  interval: number,
): Range[] {
  const out: Range[] = [];
  for (const miss of misses) {
    let { start, end } = miss;
    if (
      start - interval >= MIN &&
      coverage.some((c) => c.end === start - interval)
    ) {
      start -= interval;
    }
    if (
      end + interval <= MAX &&
      coverage.some((c) => c.start === end + interval)
    ) {
      end += interval;
    }
    const last = out.at(-1);
    if (last !== undefined && start <= last.end + interval) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({ start, end });
    }
  }
  return out;
}

export class Orchestrator {
  readonly #engine: Engine;
  readonly #auth: AuthState;
  readonly #broadcast: (evt: Evt) => void;
  readonly #inflight = new Map<string, Promise<Outcome>>();
  /** cacheCleared count per cache: the version fence (N29). */
  readonly #generation = new Map<string, number>();
  /** Bumped by updateAuth: a failure from superseded credentials is stale. */
  #authGeneration = 0;
  #fetcher: Fetcher | undefined;
  /** Reserved on the first load so a concurrent, different module conflicts. */
  #module: string | undefined;
  #loading: Promise<void> | undefined;
  #context: unknown;

  constructor(engine: Engine, broadcast: (evt: Evt) => void) {
    this.#engine = engine;
    this.#broadcast = broadcast;
    this.#auth = new AuthState(broadcast);
    engine.on("cacheCleared", ({ cacheId }) => {
      this.#generation.set(cacheId, (this.#generation.get(cacheId) ?? 0) + 1);
    });
  }

  /**
   * import()s the module once (N30). The module name is reserved before the
   * import starts, so a concurrent connection naming a different module is
   * refused with ConfigError and the same module shares the one load.
   */
  async load(config: FetcherConfig): Promise<void> {
    if (this.#module !== undefined && this.#module !== config.module) {
      throw new ConfigError(
        `this worker already runs fetcher ${this.#module}; cannot also load ${config.module}`,
      );
    }
    if (config.context !== undefined) this.#context = config.context;
    if (this.#loading === undefined) {
      this.#module = config.module;
      this.#loading = this.#import(config.module).catch((error) => {
        // A failed load leaves the slot free for a retry.
        this.#module = undefined;
        this.#loading = undefined;
        throw error;
      });
    }
    await this.#loading;
  }

  async #import(module: string): Promise<void> {
    let loaded: { default?: unknown };
    try {
      loaded = (await import(/* @vite-ignore */ module)) as {
        default?: unknown;
      };
    } catch (error) {
      throw new TscacheError(
        `fetcher module ${module} failed to load: ${describe(error).message}`,
      );
    }
    const fetcher = loaded.default as Partial<Fetcher> | undefined;
    if (typeof fetcher?.fetch !== "function") {
      throw new TscacheError(
        `fetcher module ${module} must default-export an object with fetch()`,
      );
    }
    this.#fetcher = fetcher as Fetcher;
  }

  /** New auth material: stored, handed to the fetcher, fetches resume. */
  async updateAuth(context: unknown): Promise<void> {
    this.#context = context;
    this.#authGeneration++;
    await this.#fetcher?.updateAuth?.(context);
    this.#auth.restore();
  }

  /**
   * §4.9: engine → coalesced fetches (deduplicated) → engine again. The
   * `requestId` names the get on request-scoped mergeWarning events.
   */
  async get(
    cacheId: string,
    range: Range,
    options?: GetOptions,
    requestId?: string,
  ): Promise<GetResult> {
    let result = this.#engine.get(cacheId, range);
    if (this.#fetcher === undefined || options?.cacheOnly === true)
      return result;
    const settled: Settled[] = [];
    let wanted = this.#firstPass(cacheId, range, result);
    // Two passes at most: the second re-requests only what the version
    // fence dropped and is still missing (N29).
    for (let attempt = 0; attempt < 2 && wanted.length > 0; attempt++) {
      const fetched = await Promise.all(
        wanted.map((r) => this.#fetch(cacheId, r, requestId)),
      );
      for (const [i, r] of wanted.entries()) {
        settled.push({ range: r, outcome: fetched[i] as Outcome });
      }
      result = this.#engine.get(cacheId, range);
      if (attempt === 1 || !settled.some((s) => s.outcome.kind === "dropped"))
        break;
      wanted = this.#retryPass(cacheId, range, result, settled);
    }
    return {
      ...result,
      misses: result.misses.map((m) => annotate(m, settled)),
    };
  }

  /** The coalesced ranges for every uncached miss of the first read. */
  #firstPass(cacheId: string, range: Range, result: GetResult): Range[] {
    const misses = result.misses
      .filter((m) => m.reason === "uncached")
      .map((m) => m.range);
    if (misses.length === 0) return [];
    const { interval } = this.#engine.configOf(cacheId);
    // Coverage one interval beyond the request too: a miss at the edge may
    // abut covered slots the result itself cannot show.
    const around = this.#engine.coverage(cacheId, {
      start: Math.max(range.start - interval, MIN),
      end: Math.min(range.end + interval, MAX),
    });
    return coalesce(misses, around, interval);
  }

  /**
   * After a drop everything still uncached is re-requested once, except
   * what a fetch of this get already failed or auth-blocked (N29). A clear
   * may have wiped ranges that were applied, so the dropped range alone
   * would not do.
   */
  #retryPass(
    cacheId: string,
    range: Range,
    result: GetResult,
    settled: Settled[],
  ): Range[] {
    const blocked = settled
      .filter((s) => s.outcome.kind === "failed" || s.outcome.kind === "auth")
      .map((s) => s.range);
    const uncached = result.misses
      .filter((m) => m.reason === "uncached")
      .flatMap((m) => subtract(m.range, blocked));
    if (uncached.length === 0) return [];
    return this.#firstPass(cacheId, range, {
      ...result,
      misses: uncached.map((r) => ({ range: r, reason: "uncached" as const })),
    });
  }

  /**
   * One fetch per (cacheId, range) in flight; every waiter shares it (N31).
   * The get that starts a fetch owns its mergeWarning events.
   */
  #fetch(
    cacheId: string,
    range: Range,
    requestId: string | undefined,
  ): Promise<Outcome> {
    if (!this.#auth.valid) return Promise.resolve({ kind: "auth" });
    const key = keyOf(cacheId, range);
    let pending = this.#inflight.get(key);
    if (pending === undefined) {
      pending = this.#run(cacheId, range, requestId).finally(() =>
        this.#inflight.delete(key),
      );
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  async #run(
    cacheId: string,
    range: Range,
    requestId: string | undefined,
  ): Promise<Outcome> {
    const generation = this.#generation.get(cacheId) ?? 0;
    const fetched = await this.#callFetcher(cacheId, range);
    if ("outcome" in fetched) return fetched.outcome;
    // Cleared by a newer version while in flight: this answer is stale.
    if ((this.#generation.get(cacheId) ?? 0) !== generation) {
      return { kind: "dropped" };
    }
    return this.#apply(cacheId, range, fetched.response, requestId);
  }

  /** The fetcher's answer, or the outcome its failure amounts to. */
  async #callFetcher(
    cacheId: string,
    range: Range,
  ): Promise<{ response: FetchResponse } | { outcome: Outcome }> {
    const fetcher = this.#fetcher as Fetcher;
    const { interval, alignmentOffset } = this.#engine.configOf(cacheId);
    const authGeneration = this.#authGeneration;
    try {
      const response = await fetcher.fetch({
        cacheId,
        range,
        interval,
        alignmentOffset,
        context: this.#context,
      });
      return { response };
    } catch (error) {
      if (!isAuthInvalidError(error)) {
        return { outcome: { kind: "failed", error: describe(error) } };
      }
      // A failure under credentials that updateAuth has since replaced
      // says nothing about the new ones.
      if (authGeneration === this.#authGeneration) {
        this.#auth.invalidate(describe(error));
      }
      return { outcome: { kind: "auth" } };
    }
  }

  /** Applies a response as authoritative and announces its warnings. */
  #apply(
    cacheId: string,
    range: Range,
    response: FetchResponse,
    requestId: string | undefined,
  ): Outcome {
    let warnings: MergeWarning[];
    try {
      ({ warnings } = this.#engine.put(cacheId, response, { range }));
    } catch (error) {
      return { kind: "failed", error: describe(error) };
    }
    // Once per deduplicated fetch, under the id of the get that started it.
    const id = requestId ?? "";
    for (const warning of warnings) {
      this.#broadcast({
        t: "evt",
        scope: "request",
        cacheId,
        requestId: id,
        event: "mergeWarning",
        payload: { cacheId, requestId: id, ...warning },
      });
    }
    return { kind: "applied", warnings };
  }
}

/** A remaining miss takes the reason of the fetch that covered it, if any. */
function annotate(miss: Miss, settled: Settled[]): Miss {
  for (const { range, outcome } of settled) {
    if (!overlaps(range, miss.range)) continue;
    if (outcome.kind === "failed") {
      return {
        range: miss.range,
        reason: "fetch-failed",
        error: outcome.error,
      };
    }
    if (outcome.kind === "auth")
      return { range: miss.range, reason: "auth-pending" };
  }
  return miss;
}
