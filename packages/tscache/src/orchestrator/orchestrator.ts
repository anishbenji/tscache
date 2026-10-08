/**
 * Fetch orchestration (docs/architecture.md §2.3, §2.5, §4.9): in front of
 * the Engine, turns a get's misses into deduplicated fetches, applies the
 * responses as authoritative puts, and reports what could not be fetched.
 */

import type { Engine } from "../engine/engine";
import { isAuthInvalidError, show, TscacheError } from "../errors";
import type { Evt, FetcherConfig } from "../rpc/protocol";
import type {
  Fetcher,
  FetchResponse,
  GetOptions,
  GetResult,
  Miss,
  Range,
} from "../types";
import { AuthState } from "./auth";

type Outcome =
  | { kind: "applied" }
  | { kind: "dropped" }
  | { kind: "auth" }
  | { kind: "failed"; error: { name: string; message: string } };

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

/**
 * The ranges to fetch for a result's uncached misses: adjacent misses merge,
 * and a miss abutting covered slots is extended by one interval into them
 * (locked: the one-point overlap aids range merge).
 */
export function coalesce(
  misses: Range[],
  coverage: Range[],
  interval: number,
): Range[] {
  const out: Range[] = [];
  for (const miss of misses) {
    let { start, end } = miss;
    if (coverage.some((c) => c.end === start - interval)) start -= interval;
    if (coverage.some((c) => c.start === end + interval)) end += interval;
    const last = out.at(-1);
    if (last !== undefined && start <= last.end + interval)
      last.end = Math.max(last.end, end);
    else out.push({ start, end });
  }
  return out;
}

export class Orchestrator {
  readonly #engine: Engine;
  readonly #auth: AuthState;
  readonly #inflight = new Map<string, Promise<Outcome>>();
  /** cacheCleared count per cache: the version fence (N29). */
  readonly #generation = new Map<string, number>();
  #fetcher: Fetcher | undefined;
  #module: string | undefined;
  #context: unknown;

  constructor(engine: Engine, broadcast: (evt: Evt) => void) {
    this.#engine = engine;
    this.#auth = new AuthState(broadcast);
    engine.on("cacheCleared", ({ cacheId }) => {
      this.#generation.set(cacheId, (this.#generation.get(cacheId) ?? 0) + 1);
    });
  }

  /** Whether a fetcher is loaded; without one, get stays cache-only. */
  get hasFetcher(): boolean {
    return this.#fetcher !== undefined;
  }

  /**
   * import()s the module once (N30). A later connection naming a different
   * module is a configuration conflict; the same module reuses the load.
   */
  async load(config: FetcherConfig): Promise<void> {
    if (this.#module !== undefined && this.#module !== config.module) {
      throw new TscacheError(
        `this worker already runs fetcher ${this.#module}; cannot also load ${config.module}`,
      );
    }
    if (config.context !== undefined) this.#context = config.context;
    if (this.#fetcher !== undefined) return;
    let loaded: { default?: unknown };
    try {
      loaded = (await import(/* @vite-ignore */ config.module)) as {
        default?: unknown;
      };
    } catch (error) {
      throw new TscacheError(
        `fetcher module ${config.module} failed to load: ${describe(error).message}`,
      );
    }
    const fetcher = loaded.default as Partial<Fetcher> | undefined;
    if (typeof fetcher?.fetch !== "function") {
      throw new TscacheError(
        `fetcher module ${config.module} must default-export an object with fetch()`,
      );
    }
    this.#fetcher = fetcher as Fetcher;
    this.#module = config.module;
  }

  /** New auth material: stored, handed to the fetcher, fetches resume. */
  async updateAuth(context: unknown): Promise<void> {
    this.#context = context;
    await this.#fetcher?.updateAuth?.(context);
    this.#auth.restore();
  }

  /** §4.9: engine → coalesced fetches (deduplicated) → engine again. */
  async get(
    cacheId: string,
    range: Range,
    options?: GetOptions,
  ): Promise<GetResult> {
    let result = this.#engine.get(cacheId, range);
    if (this.#fetcher === undefined || options?.cacheOnly === true)
      return result;
    const { interval } = this.#engine.configOf(cacheId);
    // Coverage one interval beyond the request too: a miss at the edge may
    // abut covered slots the result itself cannot show.
    const around = this.#engine.coverage(cacheId, {
      start: range.start - interval,
      end: range.end + interval,
    });
    const settled: { range: Range; outcome: Outcome }[] = [];
    // Two passes at most: the second only re-requests what the version
    // fence dropped (N29); failed and auth-blocked ranges are not retried.
    for (let attempt = 0; attempt < 2; attempt++) {
      const wanted = coalesce(
        result.misses
          .filter((m) => m.reason === "uncached")
          .map((m) => m.range)
          .filter(
            (r) =>
              !settled.some(
                (s) => s.outcome.kind !== "dropped" && overlaps(s.range, r),
              ),
          ),
        around,
        interval,
      );
      if (wanted.length === 0) break;
      const outcomes = await Promise.all(
        wanted.map((r) => this.#fetch(cacheId, r)),
      );
      for (const [i, r] of wanted.entries()) {
        settled.push({ range: r, outcome: outcomes[i] as Outcome });
      }
      result = this.#engine.get(cacheId, range);
      if (!outcomes.some((o) => o.kind === "dropped")) break;
    }
    return {
      ...result,
      misses: result.misses.map((m) => annotate(m, settled)),
    };
  }

  /** One fetch per (cacheId, range) in flight; every waiter shares it (N31). */
  #fetch(cacheId: string, range: Range): Promise<Outcome> {
    if (!this.#auth.valid) return Promise.resolve({ kind: "auth" });
    const key = keyOf(cacheId, range);
    let pending = this.#inflight.get(key);
    if (pending === undefined) {
      pending = this.#run(cacheId, range).finally(() =>
        this.#inflight.delete(key),
      );
      this.#inflight.set(key, pending);
    }
    return pending;
  }

  async #run(cacheId: string, range: Range): Promise<Outcome> {
    const fetcher = this.#fetcher as Fetcher;
    const { interval, alignmentOffset } = this.#engine.configOf(cacheId);
    const generation = this.#generation.get(cacheId) ?? 0;
    let response: FetchResponse;
    try {
      response = await fetcher.fetch({
        cacheId,
        range,
        interval,
        alignmentOffset,
        context: this.#context,
      });
    } catch (error) {
      if (isAuthInvalidError(error)) {
        this.#auth.invalidate(describe(error));
        return { kind: "auth" };
      }
      return { kind: "failed", error: describe(error) };
    }
    // Cleared by a newer version while in flight: this answer is stale.
    if ((this.#generation.get(cacheId) ?? 0) !== generation)
      return { kind: "dropped" };
    try {
      this.#engine.put(cacheId, response, { range });
    } catch (error) {
      return { kind: "failed", error: describe(error) };
    }
    return { kind: "applied" };
  }
}

/** A remaining miss takes the reason of the fetch that covered it, if any. */
function annotate(
  miss: Miss,
  settled: { range: Range; outcome: Outcome }[],
): Miss {
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
