/**
 * Fetch orchestration (docs/architecture.md §2.3, §2.5, §4.9, §4.9.1): in
 * front of the Engine, turns a get's misses into fetches, minus the fetches
 * already in flight for the cache, which the get awaits instead; applies
 * the responses as authoritative puts, and reports what could not be
 * fetched. Range math runs on slots (N9); milliseconds appear only at the
 * edges.
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

/** How a fetch ended, as every get awaiting it sees it (§4.9). */
type Outcome =
  | { kind: "applied"; warnings: MergeWarning[] }
  | { kind: "dropped" }
  | { kind: "auth" }
  | { kind: "failed"; error: { name: string; message: string } };

/** A fetch a get awaited, with how it ended for that get (§4.9.1 rule 4). */
interface Settled {
  range: SlotRange;
  outcome: Outcome;
}

/** A fetch in flight (§4.9.1 rule 1, N62). */
interface Inflight {
  /** The coalesced slot range sent to the fetcher, and its put's authority (N3). */
  readonly range: SlotRange;
  /** The cache's clear count when the fetch was issued (N29). */
  readonly generation: number;
  /** The auth generation when the fetch was issued (§4.9 Auth). */
  readonly authGeneration: number;
  /** Set once, by an invalidate that meets `range` (N64). */
  fenced: boolean;
  readonly outcome: Promise<Outcome>;
}

/** What one round of a get does (§4.9.1 rule 2). */
interface RoundPlan {
  /** The ranges to fetch, ascending: coalesced, flanks included. */
  fetch: SlotRange[];
  /** Indices into `inflight`, ascending: the fetches to await. */
  join: number[];
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

/**
 * `pieces` (ascending, disjoint) minus `cuts` (ascending by start), as
 * ascending pieces, in one sweep: a cut that ends before a piece starts
 * cannot touch any later piece, so it is passed once.
 */
function without(
  pieces: readonly SlotRange[],
  cuts: readonly SlotRange[],
): SlotRange[] {
  const out: SlotRange[] = [];
  let first = 0;
  for (const piece of pieces) {
    first = endingFrom(cuts, first, piece.start);
    let start = piece.start;
    for (let k = first; k < cuts.length; k++) {
      const cut = cuts[k] as SlotRange;
      if (cut.start > piece.end) break;
      if (cut.start > start) out.push({ start, end: cut.start - 1 });
      start = Math.max(start, cut.end + 1);
    }
    if (start <= piece.end) out.push({ start, end: piece.end });
  }
  return out;
}

/** The first index from `from` on whose range ends at or after `slot`. */
function endingFrom(
  ranges: readonly SlotRange[],
  from: number,
  slot: number,
): number {
  let i = from;
  while (i < ranges.length && (ranges[i] as SlotRange).end < slot) i++;
  return i;
}

/** The first index from `from` on whose range starts after `slot`. */
function startingAfter(
  ranges: readonly SlotRange[],
  from: number,
  slot: number,
): number {
  let i = from;
  while (i < ranges.length && (ranges[i] as SlotRange).start <= slot) i++;
  return i;
}

/**
 * The slot ranges to fetch for the uncached misses: adjacent misses merge,
 * and a miss abutting a covered slot is extended one slot into it (locked:
 * the one-point overlap aids range merge), never beyond the safe domain.
 * Both lists ascending: one cursor finds each miss's neighbours.
 */
export function coalesce(
  misses: SlotRange[],
  coverage: readonly SlotRange[],
  grid: Grid,
): SlotRange[] {
  const out: SlotRange[] = [];
  let next = 0;
  for (const miss of misses) {
    let { start, end } = miss;
    next = endingFrom(coverage, next, start - 1);
    if (safeSlot(start - 1, grid) && coverage[next]?.end === start - 1) {
      start -= 1;
    }
    const after = startingAfter(coverage, next, end);
    if (safeSlot(end + 1, grid) && coverage[after]?.start === end + 1) {
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

/**
 * The coalesced slot ranges to fetch for `request`: its slots outside the
 * coverage `around` it (ascending, disjoint, and one slot beyond the
 * request at each end), minus `blocked` (ascending), coalesced. Linear in
 * the number of ranges: coverage can hold thousands of fragments (step 36
 * R1-1).
 */
export function planFetches(
  request: SlotRange,
  around: readonly SlotRange[],
  blocked: readonly SlotRange[],
  grid: Grid,
): SlotRange[] {
  const open = without(without([request], around), blocked);
  if (open.length === 0) return [];
  return coalesce(open, around, grid);
}

/**
 * One round's plan (§4.9.1 rule 2, step 4). The request's slots outside
 * the coverage `around` it and outside `blocked` (both ascending, disjoint)
 * are its need; `join` is the in-flight ranges that meet the need, and
 * `fetch` is the need outside every in-flight range, coalesced, which
 * extends into coverage only (rule 3). `inflight` is ascending by start but
 * may overlap and nest, so its ends are unordered: binary search does not
 * apply, and a cursor over the need finds `join` in one pass (rule 12).
 */
export function planRound(
  request: SlotRange,
  around: readonly SlotRange[],
  inflight: readonly SlotRange[],
  blocked: readonly SlotRange[],
  grid: Grid,
): RoundPlan {
  const need = without(without([request], around), blocked);
  if (need.length === 0) return { fetch: [], join: [] };
  const join: number[] = [];
  let piece = 0;
  for (let i = 0; i < inflight.length; i++) {
    const busy = inflight[i] as SlotRange;
    // Starts ascend, so the first need piece ending at or after this start
    // only moves forward.
    piece = endingFrom(need, piece, busy.start);
    if ((need[piece]?.start ?? Number.POSITIVE_INFINITY) <= busy.end) {
      join.push(i);
    }
  }
  const open = without(need, union(inflight));
  return { fetch: open.length === 0 ? [] : coalesce(open, around, grid), join };
}

/**
 * A second round's `blocked`: the ranges of the fetches the first awaited
 * that came back failed or auth, ascending and disjoint (§4.9.1 rule 5).
 * Joined ranges can overlap, hence the sort and the union.
 */
function blockedBy(settled: readonly Settled[]): SlotRange[] {
  return union(
    settled
      .filter((s) => s.outcome.kind === "failed" || s.outcome.kind === "auth")
      .map((s) => s.range)
      .sort((a, b) => a.start - b.start),
  );
}

/** Ranges ascending by start, merged where they overlap or touch. */
function union(ranges: readonly SlotRange[]): SlotRange[] {
  const out: SlotRange[] = [];
  for (const { start, end } of ranges) {
    const last = out.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      out.push({ start, end });
    }
  }
  return out;
}

/**
 * The in-flight list with `added` merged in, both ascending by start, in
 * one pass; on equal starts the earlier entries stay first, so equal starts
 * keep issue order (§4.9.1 rule 1).
 */
function enlist(list: readonly Inflight[], added: readonly Inflight[]) {
  const out: Inflight[] = [];
  let next = 0;
  for (const entry of list) {
    while (
      next < added.length &&
      (added[next] as Inflight).range.start < entry.range.start
    ) {
      out.push(added[next++] as Inflight);
    }
    out.push(entry);
  }
  while (next < added.length) out.push(added[next++] as Inflight);
  return out;
}

export class Orchestrator {
  readonly #engine: Engine;
  readonly #auth: AuthState;
  readonly #broadcast: (evt: Evt) => void;
  /** Per cache, its fetches in flight, ascending by start (§4.9.1 rule 1). */
  readonly #inflight = new Map<string, Inflight[]>();
  /** cacheCleared count per cache: the version fence (N29). */
  readonly #generation = new Map<string, number>();
  /** Bumped when an updateAuth has taken effect: failures under older credentials are stale. */
  #authGeneration = 0;
  /** Serializes updateAuth calls. */
  #authUpdate: Promise<void> = Promise.resolve();
  /** True while a fetcher hook is replacing credentials (see #round). */
  #transitioning = false;
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
      // First load: the context (or its absence) is in place before any
      // fetch can start; nothing from an earlier failed load survives.
      this.#context = config.context;
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
    // Pure pull-model worker: nothing to deliver to, nothing to remember
    // (§4.9: a no-op without a fetcher), so a later first load starts clean.
    if (this.#loading === undefined) return Promise.resolve();
    const apply = async () => {
      // The first import may still be in flight: the hook must hear this.
      await this.#loading?.catch(() => {});
      this.#transitioning = true;
      try {
        // A copy: the hook may keep and change it; what fetches carry and
        // authInvalid names must not change with it.
        await this.#fetcher?.updateAuth?.(structuredClone(context));
      } finally {
        this.#transitioning = false;
      }
      this.#context = context;
      this.#authGeneration++;
      this.#auth.restore();
    };
    const next = this.#authUpdate.then(apply, apply);
    this.#authUpdate = next.catch(() => {});
    return next;
  }

  /**
   * §4.9, §4.9.1: rounds of coverage → subtraction of the fetches in flight
   * → coalesced fetches, then one engine read. A round plans and registers
   * its fetches in one synchronous step, so two rounds never interleave,
   * whichever tabs they serve; the engine is read once, after the fetches
   * the get awaited, or at once when it awaits none. The `requestId` names
   * the get on the request-scoped mergeWarning events of the fetches it
   * issues.
   */
  async get(
    cacheId: string,
    range: Range,
    options?: GetOptions,
    requestId?: string,
  ): Promise<GetResult> {
    if (this.#fetcher === undefined || options?.cacheOnly === true) {
      return this.#engine.get(cacheId, range, options);
    }
    const grid = this.#engine.configOf(cacheId);
    return this.#rounds(cacheId, snapOut(range, grid), requestId, (settled) => {
      // The only read: its result and `options.snapshot` come from one state
      // (§2.8, N36). #rounds calls it in the step its last round ends, with
      // no await between the last fetch and it (§4.9.1 rule 4).
      const result = this.#engine.get(cacheId, range, options);
      return {
        ...result,
        misses: result.misses.flatMap((m) => annotate(m, settled, grid)),
      };
    });
  }

  /**
   * A get's rounds, then its read: `read` gets every fetch the get awaited,
   * with its outcome, in round order, and runs in the same synchronous step
   * as the last round's end, so no other fetch lands between them. Two
   * rounds at most: the second runs when the cache was cleared while the
   * first waited, and asks for what is still missing, minus what already
   * failed (N29 as amended, rule 5). Nothing is awaited when a round has
   * nothing to await.
   */
  async #rounds(
    cacheId: string,
    request: SlotRange,
    requestId: string | undefined,
    read: (settled: Settled[]) => GetResult,
  ): Promise<GetResult> {
    const settled: Settled[] = [];
    let blocked: SlotRange[] = [];
    for (let round = 0; round < 2; round++) {
      // Read in the round's own synchronous step: the generation it plans under.
      const planned = this.#generation.get(cacheId) ?? 0;
      const awaited = this.#round(cacheId, request, blocked, requestId);
      if ("gated" in awaited) {
        for (const r of awaited.gated) {
          settled.push({ range: r, outcome: { kind: "auth" } });
        }
        break;
      }
      if (awaited.length === 0) break;
      const outcomes = await this.#awaitFetches(awaited.map((f) => f.outcome));
      for (const [i, f] of awaited.entries()) {
        settled.push({ range: f.range, outcome: outcomes[i] as Outcome });
      }
      // Every fetch a round awaits carries the generation it planned under,
      // so a dropped one implies a clear: this one comparison covers it, and
      // a clear that wiped fetches already applied too.
      if (round === 1 || (this.#generation.get(cacheId) ?? 0) === planned) {
        break;
      }
      blocked = blockedBy(settled);
    }
    return read(settled);
  }

  /**
   * engine.invalidate, then fences the fetches in flight that meet the
   * range snapped outward, so no later get joins them (§4.9.1 rule 9, N64).
   * They are still applied when they land. An invalid range throws before
   * anything is fenced.
   */
  invalidate(cacheId: string, range: Range): void {
    this.#engine.invalidate(cacheId, range);
    const list = this.#inflight.get(cacheId);
    if (list === undefined) return;
    const slots = snapOut(range, this.#engine.configOf(cacheId));
    for (const entry of list) {
      if (overlaps(entry.range, slots)) entry.fenced = true;
    }
  }

  /** Gets currently subscribed to auth invalidation (diagnostics and tests). */
  get authWaiters(): number {
    return this.#auth.waiterCount;
  }

  /**
   * Waits for the fetches, but no longer than auth stays valid: when a 401
   * flips it, the fetches still out are reported auth-pending (design y)
   * while they finish in the background.
   */
  async #awaitFetches(pending: Promise<Outcome>[]): Promise<Outcome[]> {
    const settled: (Outcome | undefined)[] = pending.map(() => undefined);
    const all = Promise.all(
      pending.map((p, i) =>
        p.then((o) => {
          settled[i] = o;
        }),
      ),
    );
    // A removable subscription, not a shared promise: a successful get must
    // leave nothing behind on the auth state.
    let unsubscribe = () => {};
    const released = new Promise<void>((resolve) => {
      unsubscribe = this.#auth.onInvalid(resolve);
    });
    try {
      await Promise.race([all, released]);
    } finally {
      unsubscribe();
    }
    return settled.map((o) => o ?? { kind: "auth" });
  }

  /**
   * One round (§4.9.1 rule 2), synchronous from the coverage read to the
   * registration of its fetches: the fetches to await, joined ones first
   * (in list order) and then its own, or, while auth is invalid or a hook
   * is swapping credentials, the ranges that come back auth-pending at once.
   */
  #round(
    cacheId: string,
    request: SlotRange,
    blocked: readonly SlotRange[],
    requestId: string | undefined,
  ): Inflight[] | { gated: SlotRange[] } {
    const grid = this.#engine.configOf(cacheId);
    // Coverage one slot beyond the request too: a miss at the edge may abut
    // covered slots the request itself cannot show. Only safe grid points.
    const probe: SlotRange = {
      start: safeSlot(request.start - 1, grid)
        ? request.start - 1
        : request.start,
      end: safeSlot(request.end + 1, grid) ? request.end + 1 : request.end,
    };
    const around = this.#engine
      .coverage(cacheId, toMs(probe, grid))
      .map((r) => snapOut(r, grid));
    // While a hook is swapping credentials the module's state and our stamp
    // can disagree, so nothing is fetched or joined: the misses come back
    // auth-pending at once (design y) and the consumer re-gets after the
    // switch. The same holds while auth is invalid.
    if (!this.#auth.valid || this.#transitioning) {
      return { gated: planFetches(request, around, blocked, grid) };
    }
    const list = this.#inflight.get(cacheId) ?? [];
    const generation = this.#generation.get(cacheId) ?? 0;
    const joinable = list.filter(
      (e) =>
        !e.fenced &&
        e.generation === generation &&
        e.authGeneration === this.#authGeneration,
    );
    const plan = planRound(
      request,
      around,
      joinable.map((e) => e.range),
      blocked,
      grid,
    );
    const joined = plan.join.map((i) => joinable[i] as Inflight);
    const own = plan.fetch.map((r) =>
      this.#issue(cacheId, r, generation, requestId),
    );
    if (own.length > 0) this.#inflight.set(cacheId, enlist(list, own));
    return [...joined, ...own];
  }

  /**
   * Starts a fetch and returns its entry, which the caller lists. The get
   * that issues a fetch owns its mergeWarning events.
   */
  #issue(
    cacheId: string,
    range: SlotRange,
    generation: number,
    requestId: string | undefined,
  ): Inflight {
    const entry: Inflight = {
      range,
      generation,
      authGeneration: this.#authGeneration,
      fenced: false,
      outcome: this.#run(cacheId, range, generation, requestId, () =>
        this.#leave(cacheId, entry),
      ),
    };
    return entry;
  }

  /** Removes a decided fetch from its cache's list, by identity. */
  #leave(cacheId: string, entry: Inflight): void {
    const list = this.#inflight.get(cacheId);
    if (list === undefined) return;
    const at = list.indexOf(entry);
    if (at !== -1) list.splice(at, 1);
    if (list.length === 0) this.#inflight.delete(cacheId);
  }

  /**
   * One fetch, from the fetcher's call to its outcome. Once the fetcher
   * settles, the outcome is decided in one synchronous step (the rejection
   * classified, or the fence checked and the response put), and the entry
   * leaves the list in that step, before the outcome settles: no plan sees
   * a decided fetch (§4.9.1 rule 1).
   */
  async #run(
    cacheId: string,
    slots: SlotRange,
    generation: number,
    requestId: string | undefined,
    leave: () => void,
  ): Promise<Outcome> {
    const fetcher = this.#fetcher as Fetcher;
    const grid = this.#engine.configOf(cacheId);
    const range = toMs(slots, grid);
    const authGeneration = this.#authGeneration;
    // Switches with the generation: the context this fetch is refused with.
    const context = this.#context;
    let answer: Promise<FetchResponse>;
    try {
      answer = Promise.resolve(
        fetcher.fetch({
          cacheId,
          // Copies: the fetcher may mutate its request; neither the put nor
          // the authInvalid event (N33) nor later fetches must see it.
          range: { start: range.start, end: range.end },
          interval: grid.interval,
          alignmentOffset: grid.alignmentOffset,
          context: structuredClone(context),
        }),
      );
    } catch (error) {
      // A fetcher that throws instead of rejecting is decided after a turn
      // like any other, so never before #issue has returned its entry and
      // the entry is listed.
      answer = Promise.reject(error);
    }
    let fetched: { response: FetchResponse } | { error: unknown };
    try {
      fetched = { response: await answer };
    } catch (error) {
      fetched = { error };
    }
    try {
      if ("error" in fetched) {
        return this.#refused(fetched.error, authGeneration, context);
      }
      // Cleared by a newer version while in flight: this answer is stale.
      if ((this.#generation.get(cacheId) ?? 0) !== generation) {
        return { kind: "dropped" };
      }
      return this.#apply(cacheId, range, fetched.response, requestId);
    } finally {
      leave();
    }
  }

  /** The outcome a fetcher's rejection amounts to. */
  #refused(error: unknown, authGeneration: number, context: unknown): Outcome {
    if (!isAuthInvalidError(error)) {
      return { kind: "failed", error: describe(error) };
    }
    // A failure under credentials that updateAuth has since replaced says
    // nothing about the new ones.
    if (authGeneration === this.#authGeneration) {
      this.#auth.invalidate(describe(error), context);
    }
    return { kind: "auth" };
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

/**
 * A remaining miss is cut at the boundaries of the fetches the get awaited
 * over it, its own and joined ones: each piece takes the reason of its
 * fetch (failed, auth-pending) and the rest stays uncached. Pieces are not
 * merged across fetches, even when their labels are equal. Where fetches
 * overlap, the one starting first labels a slot; on equal starts the one
 * awaited first, since `settled` is in round order, joined fetches (in
 * list order) before own ones, and the sort is stable (§4.9.1 rule 4).
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
