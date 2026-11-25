/**
 * Every short order of events around the deferred cleanup, for the persister
 * and for the SharedWorker hosting's persistence (step 132, Codex gate round
 * 3). A run replays a list of choices: which event comes next, and the
 * outcome of every call the code under test makes to the store opener, the
 * store and the chunk import. `explore` enumerates every list up to a bound
 * on the number of events, depth first, so each order runs exactly once and
 * the same way every time, under fake timers.
 *
 * The store holds records of caches A and B. The events: `openA`, `openB`
 * (the cache is created and opened); `clearA`, an op that clears A and, the
 * first time, throws; `invB`, an op that awaits, invalidates B and, the
 * first time, rejects; `clearAll`; `ok` and `fail`, which settle one held
 * call, the run choosing which; `next`, which advances time to the next
 * timer. A user call runs either in the same turn as the one before or after
 * that turn's work. The outcomes: the store opener resolves, rejects,
 * throws, finds no database (the store is then empty) or is held; a store
 * read, write or clearAll succeeds, fails or is held; the chunk loader
 * throws, or its import is held until `ok`, `fail` or its deadline (step
 * 132, Codex gate round 4, R4-2 and R4-3). After the last event time runs
 * out: held calls never settle, and every later call succeeds.
 *
 * After every event the run checks the properties below, each named after
 * the rule it comes from (docs/architecture.md §4.10.6 and §4.10.8, N58, N59
 * with user decisions 113 A and 123 A, N61, checklist §12). They are stated
 * on what the store, the opener and the calls' answers show, never on the
 * code's own state. A hosted order in which the chunk fails is also replayed
 * with the same calls made after the failure, and must leave the same store
 * log (`arrivalOrder`, round 4, R4-1).
 */

import { describe, expect, it, vi } from "vitest";
import { Engine } from "../src/engine/engine";
import { HostedPersistence, type LazyPersist } from "../src/persist/hosted";
import * as lazy from "../src/persist/lazy";
import { durably, Persister } from "../src/persist/persister";
import type { PersistStore, WritePlan } from "../src/persist/store";
import { deferred, MemoryStore, type StoreKind } from "./persist-memory-store";
import { all, config, fixture } from "./persist-test-helpers";

/** The persister's deadline and retry delay: two attempts fit in a deadline. */
const TIMEOUT_MS = 1500;
const DEBOUNCE_MS = 1000;

// ── the enumerator ──────────────────────────────────────────────────────

/** A run's choices, replayed from `prefix` and then the first option each. */
class Choices {
  readonly made: { pick: number; of: number }[] = [];
  readonly #prefix: readonly number[];
  /** After the last event: every call takes its first outcome, "ok". */
  settled = false;

  constructor(prefix: readonly number[]) {
    this.#prefix = prefix;
  }

  pick(of: number): number {
    if (of <= 1 || this.settled) return 0;
    const at = this.made.length;
    const pick = this.#prefix[at] ?? 0;
    if (pick >= of) throw new Error(`replay diverged at choice ${at}`);
    this.made.push({ pick, of });
    return pick;
  }
}

/** The next list of choices in depth-first order; undefined when done. */
function nextPrefix(
  made: readonly { pick: number; of: number }[],
): number[] | undefined {
  for (let at = made.length - 1; at >= 0; at--) {
    const choice = made[at] as { pick: number; of: number };
    if (choice.pick + 1 < choice.of) {
      return [...made.slice(0, at).map((c) => c.pick), choice.pick + 1];
    }
  }
  return undefined;
}

// ── what a run observes ─────────────────────────────────────────────────

interface Point {
  /** Order of observation. */
  seq: number;
  /** The event during which it was observed (0: before the first). */
  step: number;
  /** Fake time, ms. */
  time: number;
}

type Outcome = "ok" | "fail" | "throw" | "hold" | "absent";

interface Op {
  kind: "opener" | "import" | StoreKind;
  cacheId: string | undefined;
  outcome: Outcome;
  start: Point;
  end: (Point & { ok: boolean }) | undefined;
  /** Hosted: started while no persister existed (after the chunk failed). */
  unloaded: boolean;
  /** An opener call: whether it passed `ifExists` (a clear's or a cleanup's). */
  ifExists: boolean;
}

interface Call {
  kind: "open" | "removal" | "clearAll";
  cacheId: string | undefined;
  start: Point;
  end: (Point & { error: unknown; records: boolean }) | undefined;
  /** The error the op throws after its removal, if it throws. */
  planted: Error | undefined;
  /** Hosted: whether the persister existed when the call answered. */
  loadedAtEnd: boolean;
  /** A removal: when the op made it (B's op awaits first). */
  removed: Point | undefined;
}

type EventName =
  | "openA"
  | "clearA"
  | "openB"
  | "invB"
  | "clearAll"
  | "ok"
  | "fail"
  | "next";

const USER: ReadonlySet<EventName> = new Set([
  "openA",
  "clearA",
  "openB",
  "invB",
  "clearAll",
]);
const IDS = ["A", "B"] as const;

interface Violation {
  rule: string;
  detail: string;
}

/** One entry of what a run did, in order, for the replay after a failure. */
type Trace =
  | { kind: "user"; name: EventName }
  | { kind: "turn" }
  | { kind: "settle"; ok: boolean; target: Op | undefined }
  | { kind: "next" };

class Run {
  readonly choices: Choices;
  readonly hosted: boolean;
  readonly memory: MemoryStore = new MemoryStore();
  readonly engine: Engine = new Engine();
  readonly ops: Op[] = [];
  readonly calls: Call[] = [];
  readonly stops: Map<string, Point> = new Map();
  readonly held: { op: Op; settle: (ok: boolean) => void }[] = [];
  readonly events: string[] = [];
  readonly persister: Persister | undefined = undefined;
  readonly persistence: HostedPersistence | undefined = undefined;
  /** Removals answered with records left under decision #131's case. */
  open131 = 0;
  violation: Violation | undefined;
  /** What the run did; a replay has none. */
  readonly trace: Trace[] = [];
  /**
   * Hosted: how many trace entries had run when the chunk's failure was
   * first seen (undefined: it did not fail).
   */
  failedAt: number | undefined;
  #seq = 0;
  step = 0;
  #removalsOf = new Map<string, number>();
  /** A replay: the outcomes of the opener and store calls, in order. */
  readonly #replay: readonly Outcome[] | undefined;
  #replayAt = 0;

  constructor(
    hosted: boolean,
    prefix: readonly number[],
    replay?: readonly Outcome[],
  ) {
    this.choices = new Choices(prefix);
    this.hosted = hosted;
    this.#replay = replay;
    for (const id of IDS) this.memory.seed(id, fixture({ id }, [0, 4]));
    const store = this.#store();
    const opener = (o?: {
      ifExists?: boolean;
    }): Promise<PersistStore | undefined> =>
      this.#open(store, o?.ifExists === true);
    const options = {
      debounceMs: DEBOUNCE_MS,
      timeoutMs: TIMEOUT_MS,
      onStopped: (event: { cacheId: string }) => {
        if (this.stops.has(event.cacheId)) {
          this.fail("§4.10.6 Stopping: onStopped once", event.cacheId);
        } else this.stops.set(event.cacheId, this.point());
      },
    };
    if (hosted) {
      this.persistence = new HostedPersistence(
        this.engine,
        () => this.#import(),
        opener,
        options,
      );
    } else {
      this.persister = new Persister(this.engine, opener, options);
    }
  }

  point(): Point {
    return {
      seq: this.#seq++,
      step: this.step,
      time: vi.getMockedSystemTime()?.getTime() ?? 0,
    };
  }

  fail(rule: string, detail: string): void {
    this.violation ??= { rule, detail };
  }

  /** Whether the hosting has its persister (always, for the persister harness). */
  loaded(): boolean {
    return !this.hosted || this.persistence?.persister !== undefined;
  }

  #op(kind: Op["kind"], outcome: Outcome, cacheId?: string): Op {
    const op: Op = {
      kind,
      cacheId,
      outcome,
      start: this.point(),
      end: undefined,
      unloaded: !this.loaded(),
      ifExists: false,
    };
    this.ops.push(op);
    this.events.push(
      `[${kind}${cacheId === undefined ? "" : ` ${cacheId}`} ${outcome}]`,
    );
    return op;
  }

  #track(op: Op, promise: Promise<unknown>): void {
    promise.then(
      () => {
        op.end = { ...this.point(), ok: true };
      },
      () => {
        op.end = { ...this.point(), ok: false };
      },
    );
  }

  #hold(op: Op, settle: (ok: boolean) => void): void {
    this.held.push({ op, settle });
  }

  #store(): PersistStore {
    const call = <T>(
      kind: StoreKind,
      cacheId: string | undefined,
      run: () => Promise<T>,
    ): Promise<T> => {
      const outcome =
        this.#replayed() ??
        (["ok", "fail", "hold"] as const)[this.choices.pick(3)];
      const op = this.#op(kind, outcome ?? "ok", cacheId);
      if (outcome === "fail") this.memory.fail(kind);
      const gate = outcome === "hold" ? this.memory.gate(kind) : undefined;
      const promise = run();
      if (gate !== undefined) {
        this.#hold(op, (ok) => (ok ? gate.release() : gate.reject(planted())));
      }
      this.#track(op, promise);
      return promise;
    };
    return {
      read: (cacheId, pages) =>
        call("read", cacheId, () => this.memory.read(cacheId, pages)),
      write: (cacheId: string, plan: WritePlan) =>
        call("write", cacheId, () => this.memory.write(cacheId, plan)),
      clearAll: () => call("clearAll", undefined, () => this.memory.clearAll()),
      close: () => this.memory.close(),
    };
  }

  #open(
    store: PersistStore,
    ifExists: boolean,
  ): Promise<PersistStore | undefined> {
    const outcome =
      this.#replayed() ??
      (["ok", "fail", "throw", "hold", "absent"] as const)[
        this.choices.pick(5)
      ];
    const op = this.#op("opener", outcome ?? "ok");
    op.ifExists = ifExists;
    if (outcome === "throw") {
      // Seen settled after the turn, as a rejection would be.
      void Promise.resolve().then(() => {
        op.end = { ...this.point(), ok: false };
      });
      throw planted();
    }
    if (outcome === "absent") {
      // No database at the opening (round 4, R4-2): no store is open, and
      // there are no records; a later opening creates the database empty.
      for (const id of IDS)
        this.memory.seed(id, { cache: undefined, pages: [] });
      const promise = Promise.resolve(undefined);
      void promise.then(() => {
        op.end = { ...this.point(), ok: false };
      });
      return promise;
    }
    let promise: Promise<PersistStore>;
    if (outcome === "fail") promise = Promise.reject(planted());
    else if (outcome === "hold") {
      const opening = deferred<PersistStore>();
      this.#hold(op, (ok) =>
        ok ? opening.resolve(store) : opening.reject(planted()),
      );
      promise = opening.promise;
    } else promise = Promise.resolve(store);
    this.#track(op, promise);
    return promise;
  }

  /** A replay's next outcome ("ok" once they run out); undefined otherwise. */
  #replayed(): Outcome | undefined {
    if (this.#replay === undefined) return undefined;
    return this.#replay[this.#replayAt++] ?? "ok";
  }

  #import(): Promise<LazyPersist> {
    if (this.#replay !== undefined) {
      // A replay's chunk fails at once.
      const op = this.#op("import", "fail");
      const chunk = Promise.reject(planted());
      this.#track(op, chunk);
      return chunk;
    }
    // The loader may throw instead of returning a promise (round 4, R4-3).
    const outcome = (["hold", "throw"] as const)[this.choices.pick(2)];
    const op = this.#op("import", outcome ?? "hold");
    if (outcome === "throw") {
      void Promise.resolve().then(() => {
        op.end = { ...this.point(), ok: false };
      });
      throw planted();
    }
    const chunk = deferred<LazyPersist>();
    this.#hold(op, (ok) =>
      ok ? chunk.resolve(lazy) : chunk.reject(planted()),
    );
    this.#track(op, chunk.promise);
    return chunk.promise;
  }

  hasRecords(id: string): boolean {
    const records = this.memory.records(id);
    return records.cache !== undefined || records.pages.length > 0;
  }

  #call(kind: Call["kind"], cacheId?: string, planted?: Error): Call {
    const call: Call = {
      kind,
      cacheId,
      start: this.point(),
      end: undefined,
      planted,
      loadedAtEnd: false,
      removed: undefined,
    };
    this.calls.push(call);
    return call;
  }

  #answer(call: Call, error: unknown): void {
    const records =
      call.cacheId === undefined
        ? IDS.some((id) => this.hasRecords(id))
        : this.hasRecords(call.cacheId);
    call.end = { ...this.point(), error, records };
    call.loadedAtEnd = this.loaded();
    if (error !== call.planted) {
      this.fail(
        "§4.10.6 none rejects; N58: an op answers as it does",
        `${call.kind} ${call.cacheId ?? ""} answered ${String(error)}`,
      );
    }
  }

  #answers(call: Call, run: () => unknown): void {
    let result: unknown;
    try {
      result = run();
    } catch (error) {
      this.#answer(call, error);
      return;
    }
    if (result instanceof Promise) {
      result.then(
        () => this.#answer(call, undefined),
        (error: unknown) => this.#answer(call, error),
      );
    } else this.#answer(call, undefined);
  }

  opened(id: string): boolean {
    return this.calls.some((c) => c.kind === "open" && c.cacheId === id);
  }

  enabled(): EventName[] {
    const names: EventName[] = [];
    if (!this.opened("A")) names.push("openA");
    else names.push("clearA");
    if (!this.opened("B")) names.push("openB");
    else names.push("invB");
    names.push("clearAll");
    if (this.held.length > 0) names.push("ok", "fail");
    if (vi.getTimerCount() > 0) names.push("next");
    return names;
  }

  /**
   * Runs one event. A user call runs synchronously, in the current turn,
   * and returns nothing; the others flush and return a promise.
   */
  fire(name: EventName): Promise<void> | undefined {
    this.step++;
    this.events.push(name);
    switch (name) {
      case "openA":
      case "openB": {
        const id = name === "openA" ? "A" : "B";
        this.engine.cache(config({ id }));
        const call = this.#call("open", id);
        this.#answers(call, () =>
          this.hosted ? this.persistence?.open(id) : this.persister?.open(id),
        );
        return;
      }
      case "clearA":
      case "invB": {
        const id = name === "clearA" ? "A" : "B";
        // Each cache's first removal throws after it (sync for A, after an
        // await for B), so both of durably's failure paths run (round 2, R2-3).
        const count = (this.#removalsOf.get(id) ?? 0) + 1;
        this.#removalsOf.set(id, count);
        const error =
          count === 1 ? new Error(`op ${id} ${count} failed`) : undefined;
        const call = this.#call("removal", id, error);
        const op =
          id === "A"
            ? () => {
                call.removed = this.point();
                this.engine.clear("A");
                if (error !== undefined) throw error;
              }
            : async () => {
                await Promise.resolve();
                call.removed = this.point();
                this.engine.invalidate("B", all);
                if (error !== undefined) throw error;
              };
        this.#answers(call, () =>
          this.hosted
            ? this.persistence?.durably(id, op)
            : durably(this.persister as Persister, id, op),
        );
        return;
      }
      case "clearAll": {
        const call = this.#call("clearAll");
        this.#answers(call, () => {
          if (this.hosted) return this.persistence?.clearAll();
          this.engine.clearAll();
          return this.persister?.clearAll();
        });
        return;
      }
      case "ok":
      case "fail":
        return this.#settle(name === "ok");
      case "next":
        return vi.advanceTimersToNextTimerAsync().then(flush);
    }
  }

  /** Settles one held call, which the run chooses. */
  async #settle(ok: boolean): Promise<void> {
    await flush();
    const at = this.choices.pick(this.held.length);
    const [target] = this.held.splice(at, 1);
    this.trace.push({ kind: "settle", ok, target: target?.op });
    this.events.push(`<${target?.op.kind ?? ""} ${target?.op.cacheId ?? ""}>`);
    target?.settle(ok);
    await flush();
  }

  /**
   * A replay: settles the held call made in the same place as the original
   * run's `index`-th opener or store call; false when there is none.
   */
  async settleAt(index: number, ok: boolean): Promise<boolean> {
    await flush();
    const op = this.ops.filter((o) => o.kind !== "import")[index];
    const at = this.held.findIndex((h) => h.op === op);
    const [target] = at < 0 ? [] : this.held.splice(at, 1);
    target?.settle(ok);
    await flush();
    return target !== undefined;
  }

  /** A replay: the chunk's import starts, and fails, before any call. */
  async prime(): Promise<void> {
    void this.persistence?.open("primer");
    await flush();
  }

  /**
   * Hosted: whether the chunk was seen to fail: its import settled, or its
   * deadline passed, and no persister exists.
   */
  importFailed(): boolean {
    const op = this.ops.find((o) => o.kind === "import");
    if (op === undefined || this.loaded()) return false;
    const now = vi.getMockedSystemTime()?.getTime() ?? 0;
    return op.end !== undefined || now >= op.start.time + TIMEOUT_MS;
  }

  /**
   * The store log, every call's answer (its error, or pending) and each
   * cache's records at the end, as the replay compares them. Whether records
   * were left at an answer is not compared: within one turn it depends on
   * how many promise steps an answer takes, which the spec leaves open.
   */
  log(): string[] {
    const ops = this.ops
      .filter((o) => o.kind !== "import")
      .map(
        (o) =>
          `[${o.kind}${o.cacheId === undefined ? "" : ` ${o.cacheId}`} ${o.outcome} ${
            o.end === undefined ? "pending" : o.end.ok ? "ok" : "failed"
          }]`,
      );
    const calls = this.calls.map(
      (c) =>
        `${c.kind}${c.cacheId === undefined ? "" : ` ${c.cacheId}`} ${
          c.end === undefined
            ? "pending"
            : c.end.error === undefined
              ? "answered"
              : String(c.end.error)
        }`,
    );
    const left = IDS.filter((id) => this.hasRecords(id));
    return [...ops, "|", ...calls, "| records", ...left];
  }
}

function planted(): Error {
  return Object.assign(new Error("planted failure"), { name: "UnknownError" });
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

// ── the properties ──────────────────────────────────────────────────────

/** Checks every property on what the run has observed so far. */
function check(run: Run, final: boolean): void {
  const now = run.point();
  const T = TIMEOUT_MS;
  const writes = run.ops.filter((o) => o.kind === "write");
  const reads = run.ops.filter((o) => o.kind === "read");
  const openers = run.ops.filter((o) => o.kind === "opener");
  const storeClears = run.ops.filter((o) => o.kind === "clearAll");
  const clears = run.calls.filter((c) => c.kind === "clearAll");
  const removals = run.calls.filter((c) => c.kind === "removal");
  const openOf = (id: string) =>
    run.calls.find((c) => c.kind === "open" && c.cacheId === id);
  const stopOf = (id: string) => run.stops.get(id);
  const stoppedAt = (id: string, seq: number) =>
    (stopOf(id)?.seq ?? Infinity) < seq;
  const runningAt = (id: string, seq: number) =>
    (openOf(id)?.end?.seq ?? Infinity) < seq && !stoppedAt(id, seq);
  /** Stopped while its open() was pending: a stop that ended the load. */
  const loadStop = (id: string) => {
    const stop = stopOf(id);
    const open = openOf(id)?.end;
    return stop !== undefined && (open === undefined || stop.seq < open.seq);
  };
  const removalsOf = (id: string) => removals.filter((r) => r.cacheId === id);
  /** When a removal was made: its op may make it after an await. */
  const made = (r: Call) => (r.removed ?? r.start).seq;
  const storeOpenAt = (seq: number) =>
    openers.some((o) => o.end?.ok === true && o.end.seq < seq);
  /**
   * An opening was in flight at `at`: one that settled in the same event
   * counts, since the code sees it settle a few microtasks after the run.
   */
  const openerPendingAt = (at: Point) =>
    openers.some(
      (o) =>
        o.start.seq < at.seq &&
        (o.end === undefined || o.end.seq > at.seq || o.end.step === at.step),
    );
  /** The first call of the barrier `c` joined (calls overlapping it). */
  const barrierStart = (c: Call): Point => {
    let start = c.start;
    for (const other of clears) {
      if (
        other.start.seq < start.seq &&
        (other.end === undefined || other.end.seq > c.start.seq)
      ) {
        start = other.start;
      }
    }
    return start;
  };
  /**
   * The store.clearAll that emptied the disk for `c`, or the opening that
   * found no database, so nothing to clear (§4.10.6 clearAll), if one did.
   * The clear's own opening is the last one with `ifExists` that settled in
   * its barrier; with none, it shared a load's opening.
   */
  const emptied = (c: Call) => {
    if (c.end === undefined) return undefined;
    const end = c.end.seq;
    const within = (k: Op) =>
      k.start.seq > barrierStart(c).seq &&
      k.end !== undefined &&
      k.end.seq < end;
    const cleared = storeClears.find((k) => within(k) && k.end?.ok === true);
    if (cleared !== undefined) return cleared;
    const settled = openers
      .filter(within)
      .sort((a, b) => (a.end?.seq ?? 0) - (b.end?.seq ?? 0));
    const own = settled.filter((o) => o.ifExists);
    const opening = own.length > 0 ? own.at(-1) : settled.at(-1);
    return opening?.outcome === "absent" ? opening : undefined;
  };
  const cleared = (c: Call) => emptied(c) !== undefined;
  const failedClear = (c: Call) => c.end !== undefined && !cleared(c);
  const name = (op: Op) => `${op.kind} ${op.cacheId ?? ""} at ${op.start.step}`;

  for (const c of clears) {
    const bs = barrierStart(c);
    // The barrier ends when the disk was emptied, or when the call answered.
    const end = emptied(c)?.end?.seq ?? c.end?.seq ?? Infinity;
    // (i) and (l) are the persister's barrier; a clearAll after the hosting's
    // chunk failed has none (§4.10.8), and is checked below.
    const barrier = c.end === undefined ? run.loaded() : c.loadedAtEnd;
    // (i): no write between a clearAll() call and its settling, except the
    // attempt running at the call and the cleanups queued before it.
    for (const w of writes) {
      if (!barrier || w.start.seq <= c.start.seq || w.start.seq >= end)
        continue;
      const id = w.cacheId as string;
      const stop = stopOf(id);
      const queuedBefore =
        stop !== undefined &&
        stop.seq < bs.seq &&
        (!loadStop(id) ||
          removalsOf(id).some((r) => made(r) > stop.seq && made(r) < bs.seq));
      const runningAttempt =
        runningAt(id, bs.seq) &&
        openerPendingAt(bs) &&
        writes.find((x) => x.cacheId === id && x.start.seq > bs.seq) === w;
      if (!queuedBefore && !runningAttempt) {
        run.fail(
          "§4.10.6 (i): a write during a clearAll barrier",
          `${name(w)}, clearAll at ${c.start.step}`,
        );
      }
    }
    for (const r of reads) {
      if (barrier && r.start.seq > c.start.seq && r.start.seq < end) {
        run.fail(
          "§4.10.6 (i), (h2): a read during a clearAll barrier",
          name(r),
        );
      }
    }
    // (l): a removal during the barrier is durable when the job settles,
    // within timeoutMs of the call.
    for (const r of removals) {
      if (!barrier || made(r) <= c.start.seq || made(r) >= end) continue;
      const id = r.cacheId as string;
      const stop = stopOf(id);
      // On success with no write of its own; a cleanup queued before the
      // call is not its own.
      const queuedBefore =
        stop !== undefined &&
        stop.seq < bs.seq &&
        (!loadStop(id) ||
          removalsOf(id).some((x) => made(x) > stop.seq && made(x) < bs.seq));
      const own = stoppedAt(id, made(r))
        ? writes.find((w) => w.cacheId === id && w.start.seq > made(r))
        : undefined;
      if (cleared(c) && own !== undefined && !queuedBefore) {
        run.fail(
          "§4.10.6 (l): a removal during the barrier wrote a cleanup of its own",
          `${name(own)}, removal ${id} at ${r.start.step}`,
        );
      }
      // A removal made on a running cache answers no earlier than the
      // clearAll that owns it, even when the cache stops meanwhile: the clear
      // is then its deletion (round 5, R5-1).
      if (
        r.end !== undefined &&
        runningAt(id, made(r)) &&
        (c.end === undefined || r.end.step < c.end.step)
      ) {
        run.fail(
          "§4.10.6 (l): a removal during the barrier answered before it settled",
          `removal ${id} at ${r.start.step}`,
        );
      }
      const at = r.end?.time ?? now.time;
      if (!run.hosted && at > bs.time + T) {
        run.fail(
          "§4.10.6 (l): a removal during the barrier answered after timeoutMs",
          `removal ${id} at ${r.start.step}`,
        );
      }
    }
    // (n): after a failed clearAll nothing is written or read again.
    if (failedClear(c) && c.loadedAtEnd) {
      for (const o of [...writes, ...reads]) {
        if (o.start.seq > end) {
          run.fail(
            "§4.10.6 (n): a store call after a failed clearAll",
            `${name(o)}, clearAll at ${c.start.step}`,
          );
        }
      }
    }
    // N59 amendment for user decision 123 A, §4.10.6 Failures: the clear is
    // the cleanup of every cache whose cleanup was deferred at the call.
    for (const w of writes) {
      if (w.start.seq <= c.start.seq) continue;
      const id = w.cacheId as string;
      const open = openOf(id);
      if (
        open !== undefined &&
        open.start.seq < c.start.seq &&
        stoppedAt(id, w.start.seq) &&
        loadStop(id) &&
        // In arrival order: the hosting holds a removal for the chunk and
        // runs it, and its cleanup, before a later clearAll (§4.10.8).
        !removalsOf(id).some(
          (r) => r.start.seq > open.start.seq && r.start.seq < c.start.seq,
        )
      ) {
        run.fail(
          "N59 (123 A), §4.10.6 Failures: a cleanup of a cache the clearAll's clear removed",
          `${name(w)}, clearAll at ${c.start.step}`,
        );
      }
    }
    // §4.10.6 clearAll: it resolves once the disk is empty, or its job failed.
    if (c.end?.records && !failedClear(c)) {
      run.fail(
        "§4.10.6 clearAll: answered with records left after its clear",
        `clearAll at ${c.start.step}`,
      );
    }
    // §4.10.6 clearAll (the job opens the store), §4.10.8: a clear that
    // failed tried to open the store when none was open or opening (R3-3).
    if (
      failedClear(c) &&
      !storeOpenAt(bs.seq) &&
      !openerPendingAt(bs) &&
      !openers.some((o) => o.start.seq > bs.seq && o.start.seq < end)
    ) {
      run.fail(
        "§4.10.6 clearAll: failed without opening the store",
        `clearAll at ${c.start.step}`,
      );
    }
  }

  // §4.10.6 Failures, N59: one cleanup at most; a whole-store clear started
  // after the stop was its cleanup.
  for (const w of writes) {
    const id = w.cacheId as string;
    const stop = stopOf(id);
    if (stop === undefined || stop.seq > w.start.seq) continue;
    const again = writes.find(
      (x) =>
        x.cacheId === id && x.start.seq > stop.seq && x.start.seq < w.start.seq,
    );
    const open = openOf(id)?.start.seq ?? Infinity;
    // A store clear of a clearAll called after the cache opened; one an
    // older clearAll, still pending, may own does not count.
    const cleared = storeClears.find(
      (k) =>
        k.start.seq > stop.seq &&
        k.start.seq < w.start.seq &&
        clears.some((c) => c.start.seq > open && c.start.seq < k.start.seq) &&
        !clears.some(
          (c) => c.start.seq < open && (c.end?.seq ?? Infinity) > k.start.seq,
        ),
    );
    if (again !== undefined || cleared !== undefined) {
      run.fail(
        "§4.10.6 Failures, N59: a cache's records deleted twice",
        `${name(w)} after ${name((again ?? cleared) as Op)}`,
      );
    }
  }

  // N58, §4.10.6 Durability: a removal answers once its records are gone,
  // or once a failure the spec names released it.
  const accepted: Call[] = [];
  for (const r of removals) {
    const a = r.end;
    if (a === undefined || !a.records) continue;
    const id = r.cacheId as string;
    const stop = stopOf(id);
    const stopped = stoppedAt(id, a.seq);
    const last = writes
      .filter((w) => w.cacheId === id && w.start.seq < a.seq)
      .at(-1);
    const abandoned = (op: Op) =>
      (op.end === undefined || op.end.seq > a.seq) &&
      a.time - op.start.time >= T;
    // §4.10.6 Failures: its cleanup failed, or the job's write did.
    const writeFailed =
      stopped &&
      last !== undefined &&
      ((last.end !== undefined && !last.end.ok && last.end.seq < a.seq) ||
        abandoned(last));
    // §4.10.6 Open, Stopping: no store could be opened for it: an opening
    // failed before a stop that came after the removal, or after the stop
    // (its cleanup's), or one hung past the deadline.
    const failedBetween = (from: number, to: number) =>
      openers.some(
        (o) =>
          o.end !== undefined &&
          !o.end.ok &&
          o.end.seq > from &&
          o.end.seq < to,
      );
    // Not while a persister's clearAll that owns the removal is pending at
    // the answer: the removal was made on a running cache during its
    // barrier, or the cache stopped during it, so the clear is the cache's
    // deletion and settles the removal (§4.10.6 (l), Success; round 5,
    // R5-1). A cleanup queued before the call runs ahead of the clear, and
    // a removal of the stopped cache waits for it instead.
    const clearPending = clears.some((c) => {
      const bs = barrierStart(c).seq;
      return (
        c.start.seq < a.seq &&
        (c.end === undefined ? run.loaded() : c.loadedAtEnd) &&
        (c.end?.step ?? Infinity) > a.step &&
        ((made(r) > bs && runningAt(id, made(r))) || (stop?.seq ?? -1) > bs)
      );
    });
    const openFailed =
      !clearPending &&
      stopped &&
      stop !== undefined &&
      !storeOpenAt(Math.min(a.seq, stop.seq)) &&
      ((stop.seq > made(r) && failedBetween(-1, stop.seq)) ||
        failedBetween(stop.seq, a.seq) ||
        openers.some((o) => o.start.seq < a.seq && abandoned(o)));
    // N61, §4.10.6 The writer: its cleanup's deadline passed while a store
    // call or an opening still held the writer or the store.
    const due = [
      stop?.time ?? Infinity,
      ...removalsOf(id)
        .filter((x) => stop !== undefined && made(x) > stop.seq)
        .map((x) => (x.removed ?? x.start).time),
    ];
    const blocked =
      stopped &&
      due.some((t) => a.time - t >= T) &&
      run.ops.some(
        (o) =>
          o.kind !== "read" &&
          o.kind !== "import" &&
          o.start.seq < a.seq &&
          (o.end === undefined || o.end.seq > a.seq),
      );
    // §4.10.6 clearAll, Failure; §4.10.8: a failed clear was its deletion.
    const open = openOf(id);
    const clearFailed = clears.some((c) => {
      // By the event of the answer: the code sees the clear fail a few
      // microtasks before the run sees the call answer.
      if (!failedClear(c) || (c.end?.step ?? Infinity) > a.step) return false;
      const bs = barrierStart(c);
      const cEnd = c.end?.seq ?? Infinity;
      if (cEnd < made(r)) {
        return (open !== undefined && open.start.seq < cEnd) || c.loadedAtEnd;
      }
      return made(r) >= bs.seq || !stoppedAt(id, made(r));
    });
    // §4.10.6 Stopping: a stop with no store open, which did not end the
    // load, has no cleanup at all, so no later removal deletes anything
    // (decision #131's family). A stop after a failed opening defers its
    // cleanup instead, and is not this case.
    const noCleanup =
      stopped &&
      stop !== undefined &&
      !loadStop(id) &&
      !storeOpenAt(stop.seq) &&
      !failedBetween(-1, stop.seq);
    // §4.10.6 Failures, one cleanup at most: an earlier removal of the
    // stopped cache waited for it, and it left the records.
    const spent = accepted.some(
      (x) =>
        x.cacheId === id &&
        stoppedAt(id, made(x)) &&
        (x.end?.seq ?? Infinity) < made(r),
    );
    if (writeFailed || openFailed || clearFailed || blocked || noCleanup) {
      accepted.push(r);
    }
    if (
      !writeFailed &&
      !openFailed &&
      !clearFailed &&
      !blocked &&
      !noCleanup &&
      !spent
    ) {
      run.fail(
        "N58, §4.10.6 Durability: a removal answered with its records left",
        `removal ${id} at ${r.start.step}`,
      );
    } else if (
      (noCleanup || (openFailed && !stoppedAt(id, made(r)))) &&
      !writeFailed &&
      !clearFailed &&
      !blocked
    ) {
      // Decision #131 (open): a removal not yet durable when the store could
      // not be opened is released by the stop; the records stay. Pinned.
      run.open131++;
    }
  }

  // §4.10.6 Failures, §4.10.8 (user decision 113 A): a deferred cleanup
  // opens a store that exists when none is open or opening (round 3, R3-3).
  for (const r of removals) {
    const id = r.cacheId as string;
    const stop = stopOf(id);
    const open = openOf(id);
    if (r.end === undefined || stop === undefined || open === undefined)
      continue;
    const m = made(r);
    const deferredAt =
      loadStop(id) &&
      stop.seq < m &&
      !removalsOf(id).some((x) => made(x) > stop.seq && made(x) < m) &&
      !clears.some(
        (c) =>
          c.start.seq < m &&
          (c.start.seq > open.start.seq ||
            failedClear(c) ||
            // The persister's clear that succeeded after the cache stopped
            // during its barrier was its cleanup (§4.10.6 Success, R3-2).
            (c.loadedAtEnd &&
              cleared(c) &&
              barrierStart(c).seq < stop.seq &&
              (emptied(c)?.end?.seq ?? -1) > stop.seq)),
      );
    const end = r.end.seq;
    if (
      deferredAt &&
      !storeOpenAt(m) &&
      !openerPendingAt(r.removed ?? r.start) &&
      !openers.some((o) => o.start.seq > m && o.start.seq < end)
    ) {
      run.fail(
        "§4.10.6 Failures (113 A): a deferred cleanup opened no store",
        `removal ${id} at ${r.start.step}`,
      );
    }
  }

  // N61, §4.10.6 Durability, §4.10.8: every call answers by its deadline.
  for (const c of run.calls) {
    const limit =
      c.kind === "open"
        ? T
        : c.kind === "removal"
          ? (run.hosted ? 3 : 2) * T
          : (run.hosted ? 2 : 1) * T;
    const at = c.end?.time ?? (final ? Infinity : now.time);
    if (at > c.start.time + limit) {
      run.fail(
        "N61, §4.10.6 Durability, §4.10.8: a call answered after its deadline",
        `${c.kind} ${c.cacheId ?? ""} at ${c.start.step}`,
      );
    }
  }

  // §4.10.8 (security lane 3, S3.2): an opening that resolves late still
  // runs its deletion.
  if (final) {
    for (const o of openers) {
      if (!o.unloaded || o.end?.ok !== true) continue;
      const end = o.end.seq;
      if (
        !run.ops.some(
          (x) =>
            (x.kind === "write" || x.kind === "clearAll") && x.start.seq > end,
        )
      ) {
        run.fail(
          "§4.10.8 (S3.2): an opening that resolved ran no deletion",
          name(o),
        );
      }
    }
  }
}

// ── running the orders ──────────────────────────────────────────────────

interface Failure extends Violation {
  events: string;
  prefix: string;
}

interface Explored {
  orders: number;
  failures: Failure[];
  /** Orders that reached decision #131's case (pinned, not a failure). */
  open131: number;
}

/** Runs one order: its events up to `bound`, then time runs out. */
async function runOrder(
  hosted: boolean,
  prefix: readonly number[],
  bound: number,
  first: EventName,
): Promise<Run> {
  vi.useFakeTimers({ now: 0 });
  const run = new Run(hosted, prefix);
  /** Notes the trace position at which the chunk's failure was first seen. */
  const seen = () => {
    if (run.hosted && run.failedAt === undefined && run.importFailed()) {
      run.failedAt = run.trace.length;
    }
  };
  try {
    let user = false;
    for (
      let events = 0;
      events < bound && run.violation === undefined;
      events++
    ) {
      let names = run.enabled();
      if (events === 0) names = names.filter((n) => n === first);
      else if (user) {
        // After a user call: the next one in the same turn, or not.
        const same = names.filter((n) => USER.has(n));
        const pick = run.choices.pick(1 + same.length);
        if (pick === 0) {
          await flush();
          run.trace.push({ kind: "turn" });
          seen();
          check(run, false);
          if (run.violation !== undefined) break;
          names = run.enabled();
        } else names = [same[pick - 1] as EventName];
      }
      const name = names[run.choices.pick(names.length)];
      if (name === undefined) break;
      if (USER.has(name)) run.trace.push({ kind: "user", name });
      else if (name === "next") run.trace.push({ kind: "next" });
      const settled = run.fire(name);
      if (settled !== undefined) await settled;
      seen();
      user = USER.has(name);
      check(run, false);
    }
    if (run.violation === undefined) {
      await flush();
      seen();
      check(run, false);
    }
    await timeRunsOut(run);
    seen();
    check(run, true);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  if (run.violation === undefined && run.failedAt !== undefined) {
    await arrivalOrder(run, run.failedAt);
  }
  return run;
}

/**
 * Time runs out: every deadline passes; held calls never settle, and every
 * call made from now on succeeds.
 */
async function timeRunsOut(run: Run): Promise<void> {
  run.step++;
  run.events.push("(end)");
  run.choices.settled = true;
  for (let i = 0; i < 40 && vi.getTimerCount() > 0; i++) {
    if (run.violation !== undefined) break;
    await vi.advanceTimersToNextTimerAsync();
    check(run, false);
  }
  await flush();
}

/**
 * §4.10.8, arrival order (step 132, Codex gate round 4, R4-1): the calls
 * made while the chunk loaded take effect in the order they arrived, so an
 * order in which the import fails leaves what the same calls leave when
 * they come after the failure. The replay fails the chunk first, makes the
 * calls that waited for it in one turn, then repeats the rest of the run,
 * every opener and store call taking the outcome it had. The store log and
 * every call's answer (its error, and whether records were left) must be
 * the run's.
 */
async function arrivalOrder(run: Run, failedAt: number): Promise<void> {
  const outcomes = run.ops
    .filter((o) => o.kind !== "import")
    .map((o) => o.outcome);
  const original = run.ops.filter((o) => o.kind !== "import");
  vi.useFakeTimers({ now: 0 });
  const replay = new Run(true, [], outcomes);
  let lost: string | undefined;
  try {
    await replay.prime();
    for (const entry of run.trace.slice(0, failedAt)) {
      // A user call returns nothing: it runs in this turn.
      if (entry.kind === "user") void replay.fire(entry.name);
    }
    // The turn in which the failure ran the waiting calls.
    await flush();
    for (const entry of run.trace.slice(failedAt)) {
      // A user call returns nothing: it runs in this turn.
      if (entry.kind === "user") void replay.fire(entry.name);
      else if (entry.kind === "turn") await flush();
      else if (entry.kind === "next") {
        await vi.advanceTimersToNextTimerAsync();
        await flush();
      } else if (entry.target?.kind === "import") {
        // The chunk settling after its deadline: it changes nothing.
        await flush();
        await flush();
      } else {
        const index = original.indexOf(entry.target as Op);
        if (!(await replay.settleAt(index, entry.ok))) {
          lost ??= `no held call to settle in the replay at ${index}`;
        }
      }
    }
    await flush();
    await timeRunsOut(replay);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
  const got = run.log().join(" ");
  const want = replay.log().join(" ");
  if (lost !== undefined || got !== want) {
    run.fail(
      "§4.10.8 arrival order: an order with the chunk failing differs from its calls after the failure",
      `${got} ≠ replay ${want}${lost === undefined ? "" : ` (${lost})`} [${replay.events.join(" ")}]`,
    );
  }
}

/**
 * Runs every order of at most `bound` events that starts with `first`, with
 * every outcome of every call, once each.
 */
async function explore(
  hosted: boolean,
  bound: number,
  first: EventName,
): Promise<Explored> {
  const result: Explored = { orders: 0, failures: [], open131: 0 };
  let prefix: number[] | undefined = [];
  while (prefix !== undefined) {
    const run = await runOrder(hosted, prefix, bound, first);
    result.orders++;
    if (run.open131 > 0) result.open131++;
    if (run.violation !== undefined) {
      result.failures.push({
        ...run.violation,
        events: run.events.join(" "),
        prefix: run.choices.made.map((c) => c.pick).join(","),
      });
    }
    prefix = nextPrefix(run.choices.made);
  }
  return result;
}

/**
 * One entry per rule broken: how many orders broke it, and the shortest of
 * them with its choices (`runOrder` with them as `prefix` replays it).
 */
function byRule(
  failures: readonly Failure[],
): Record<string, { orders: number; shortest: string; choices: string }> {
  const out: Record<
    string,
    { orders: number; shortest: string; choices: string }
  > = {};
  for (const f of failures) {
    const seen = out[f.rule];
    const shortest = `${f.events} (${f.detail})`;
    if (seen === undefined) {
      out[f.rule] = { orders: 1, shortest, choices: f.prefix };
      continue;
    }
    seen.orders++;
    if (shortest.length < seen.shortest.length) {
      seen.shortest = shortest;
      seen.choices = f.prefix;
    }
  }
  return out;
}

// ── the tests ───────────────────────────────────────────────────────────

const env = (globalThis as { process?: { env: Record<string, string> } })
  .process?.env;
/**
 * Events per order: 3 in the normal suite and in `bun run ci`, 7,442 orders
 * (4,577 persister, 2,865 hosted) in about a second. TSCACHE_EVENT_ORDERS=5
 * runs every order that the round 1-3 reproductions fit (R3-2, the longest:
 * openA, clearAll, openB, invB, fail): 1,166,766 orders (650,904 and
 * 515,862), about 160 s and 205 s for the two files on an idle machine, side
 * by side (step 132, round 4: two more outcomes and the arrival-order
 * replay).
 */
const BOUND = Number(env?.TSCACHE_EVENT_ORDERS ?? 3);

/** Declares one harness's order tests, one per first event. */
export function orderTests(hosted: boolean): void {
  describe(`every order of up to ${BOUND} events`, () => {
    it.each(["openA", "openB", "clearAll"] as const)(
      "starting with %s",
      async (first) => {
        const result = await explore(hosted, BOUND, first);
        expect(byRule(result.failures)).toEqual({});
        // Decision #131 (open): a removal not yet durable when the store's
        // opening fails is released by the stop, its records left. Today's
        // behaviour, pinned: the properties accept it, and it is reached.
        if (!hosted && first !== "clearAll") {
          expect(result.open131).toBeGreaterThan(0);
        }
      },
      BOUND > 3 ? 900_000 : undefined,
    );
  });
}
