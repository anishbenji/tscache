/**
 * Fetch orchestration (docs/architecture.md §2.3, §2.5, §4.9): in front of
 * the Engine, turns a get's misses into deduplicated fetches, applies the
 * responses as authoritative puts, and reports what could not be fetched.
 * Range math runs on slots (N9); milliseconds appear only at the edges.
 */

import type { Engine } from "../engine/engine";
import { ConfigError, isAuthInvalidError, show, TscacheError } from "../errors";
import { type Grid, msOf, type SlotRange, snapOut, toMs } from "../grid";
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
  range: SlotRange;
  outcome: Outcome;
}

interface Inflight {
  promise: Promise<Outcome>;
  /** Credentials this fetch started under; a later get must not join a stale one. */
  authGeneration: number;
  /** Cache generation it started under; a fence-dropped fetch is not joined. */
  generation: number;
}

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

function overlaps(a: SlotRange, b: SlotRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** Whether a slot and its timestamp both lie in the safe-integer domain. */
function safeSlot(slot: number, grid: Grid): boolean {
  return Number.isSafeInteger(slot) && Number.isSafeInteger(msOf(slot, grid));
}

/** `range` minus every range in `cuts`, as ascending pieces. */
function subtract(range: SlotRange, cuts: SlotRange[]): SlotRange[] {
  let pieces: SlotRange[] = [range];
  for (const cut of cuts) {
    pieces = pieces.flatMap((p) => {
      if (!overlaps(p, cut)) return [p];
      const out: SlotRange[] = [];
      if (p.start < cut.start) out.push({ start: p.start, end: cut.start - 1 });
      if (p.end > cut.end) out.push({ start: cut.end + 1, end: p.end });
      return out;
    });
  }
  return pieces;
}

/**
 * The slot ranges to fetch for the uncached misses: adjacent misses merge,
 * and a miss abutting a covered slot is extended one slot into it (locked:
 * the one-point overlap aids range merge), never beyond the safe domain.
 */
export function coalesce(
  misses: SlotRange[],
  coverage: SlotRange[],
  grid: Grid,
): SlotRange[] {
  const out: SlotRange[] = [];
  for (const miss of misses) {
    let { start, end } = miss;
    if (
      safeSlot(start - 1, grid) &&
      coverage.some((c) => c.end === start - 1)
    ) {
      start -= 1;
    }
    if (safeSlot(end + 1, grid) && coverage.some((c) => c.start === end + 1)) {
      end += 1;
    }
    const last = out.at(-1);
    if (last !== undefined && start <= last.end + 1) {
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
  readonly #inflight = new Map<string, Inflight>();
  /** cacheCleared count per cache: the version fence (N29). */
  readonly #generation = new Map<string, number>();
  /** Bumped when an updateAuth has taken effect: failures under older credentials are stale. */
  #authGeneration = 0;
  /** Serializes updateAuth calls. */
  #authUpdate: Promise<void> = Promise.resolve();
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
    if (this.#loading === undefined) {
      // First load: the context is in place before any fetch can start.
      if (config.context !== undefined) this.#context = config.context;
      this.#module = config.module;
      this.#loading = this.#import(config.module).catch((error) => {
        // A failed load leaves the slot free for a retry.
        this.#module = undefined;
        this.#loading = undefined;
        throw error;
      });
      await this.#loading;
      return;
    }
    await this.#loading;
    // A joining tab with other material takes the updateAuth path once the
    // module is there, so its hook hears it and the generation advances.
    // Only an identical value is "the same"; anything else is conservatively
    // new (structured-cloneable values have no cheap, cycle-safe equality).
    if (
      config.context !== undefined &&
      !Object.is(config.context, this.#context)
    ) {
      await this.updateAuth(config.context);
    }
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

  /**
   * New auth material. Updates are applied in call order, one at a time:
   * the fetcher hears it, then the context and generation switch together
   * and fetching resumes. A fetch never waits for a transition: one that
   * starts meanwhile carries the credentials still in place and their
   * generation, so its auth failure, if any, is ignored (design y: a get
   * never blocks on a credential refresh).
   */
  updateAuth(context: unknown): Promise<void> {
    const apply = async () => {
      await this.#fetcher?.updateAuth?.(context);
      this.#context = context;
      this.#authGeneration++;
      this.#auth.restore();
    };
    const next = this.#authUpdate.then(apply, apply);
    this.#authUpdate = next.catch(() => {});
    return next;
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
    if (this.#fetcher === undefined || options?.cacheOnly === true) {
      return result;
    }
    const grid = this.#engine.configOf(cacheId);
    const request = snapOut(range, grid);
    const settled: Settled[] = [];
    let wanted = this.#plan(cacheId, request, uncached(result, grid), []);
    // Two passes at most: the second re-requests only what is still
    // uncached after a version-fence drop, minus what already failed (N29).
    for (let attempt = 0; attempt < 2 && wanted.length > 0; attempt++) {
      const outcomes = await Promise.all(
        wanted.map((r) => this.#fetch(cacheId, toMs(r, grid), requestId)),
      );
      for (const [i, r] of wanted.entries()) {
        settled.push({ range: r, outcome: outcomes[i] as Outcome });
      }
      result = this.#engine.get(cacheId, range);
      if (attempt === 1 || !outcomes.some((o) => o.kind === "dropped")) break;
      const blocked = settled
        .filter((s) => s.outcome.kind === "failed" || s.outcome.kind === "auth")
        .map((s) => s.range);
      wanted = this.#plan(cacheId, request, uncached(result, grid), blocked);
    }
    return {
      ...result,
      misses: result.misses.flatMap((m) => annotate(m, settled, grid)),
    };
  }

  /** The coalesced slot ranges to fetch for these misses, minus `blocked`. */
  #plan(
    cacheId: string,
    request: SlotRange,
    misses: SlotRange[],
    blocked: SlotRange[],
  ): SlotRange[] {
    const open = misses.flatMap((m) => subtract(m, blocked));
    if (open.length === 0) return [];
    const grid = this.#engine.configOf(cacheId);
    // Coverage one slot beyond the request too: a miss at the edge may abut
    // covered slots the result itself cannot show. Only safe grid points.
    const probe: SlotRange = {
      start: safeSlot(request.start - 1, grid)
        ? request.start - 1
        : request.start,
      end: safeSlot(request.end + 1, grid) ? request.end + 1 : request.end,
    };
    const around = this.#engine
      .coverage(cacheId, toMs(probe, grid))
      .map((r) => snapOut(r, grid));
    return coalesce(open, around, grid);
  }

  /**
   * One fetch per (cacheId, range) in flight; every waiter shares it (N31),
   * unless it started under credentials that updateAuth has since replaced.
   * The get that starts a fetch owns its mergeWarning events.
   */
  async #fetch(
    cacheId: string,
    range: Range,
    requestId: string | undefined,
  ): Promise<Outcome> {
    if (!this.#auth.valid) return { kind: "auth" };
    const key = `${cacheId}\u0000${range.start}\u0000${range.end}`;
    const generation = this.#generation.get(cacheId) ?? 0;
    const current = this.#inflight.get(key);
    if (
      current !== undefined &&
      current.authGeneration === this.#authGeneration &&
      current.generation === generation
    ) {
      return current.promise;
    }
    const entry: Inflight = {
      authGeneration: this.#authGeneration,
      generation,
      promise: this.#run(cacheId, range, requestId).finally(() => {
        if (this.#inflight.get(key) === entry) this.#inflight.delete(key);
      }),
    };
    this.#inflight.set(key, entry);
    return entry.promise;
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

/** The uncached misses of a result, in slots (their ends are aligned). */
function uncached(result: GetResult, grid: Grid): SlotRange[] {
  return result.misses
    .filter((m) => m.reason === "uncached")
    .map((m) => snapOut(m.range, grid));
}

/**
 * A remaining miss is cut at the boundaries of the fetches that covered it:
 * each piece takes the reason of its fetch (failed, auth-pending) and the
 * rest stays uncached.
 */
function annotate(miss: Miss, settled: Settled[], grid: Grid): Miss[] {
  const slots = snapOut(miss.range, grid);
  const labelled = settled.filter(
    (s) =>
      (s.outcome.kind === "failed" || s.outcome.kind === "auth") &&
      overlaps(s.range, slots),
  );
  if (labelled.length === 0) return [miss];
  const out: Miss[] = [];
  let cursor = slots.start;
  for (const { range, outcome } of labelled.sort(
    (a, b) => a.range.start - b.range.start,
  )) {
    const start = Math.max(range.start, cursor);
    const end = Math.min(range.end, slots.end);
    if (start > end) continue;
    if (cursor < start) {
      out.push({
        range: toMs({ start: cursor, end: start - 1 }, grid),
        reason: "uncached",
      });
    }
    out.push(
      outcome.kind === "failed"
        ? {
            range: toMs({ start, end }, grid),
            reason: "fetch-failed",
            error: outcome.error,
          }
        : { range: toMs({ start, end }, grid), reason: "auth-pending" },
    );
    cursor = end + 1;
  }
  if (cursor <= slots.end) {
    out.push({
      range: toMs({ start: cursor, end: slots.end }, grid),
      reason: "uncached",
    });
  }
  return out;
}
