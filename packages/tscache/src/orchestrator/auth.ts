/**
 * Auth state (docs/architecture.md §2.5, §4.9; designs b and y): a fetch
 * that throws AuthInvalidError flips the state to invalid and every tab
 * hears it once; nothing is fetched until updateAuth flips it back.
 */

import type { Evt } from "../rpc/protocol";

export class AuthState {
  readonly #broadcast: (evt: Evt) => void;
  #valid = true;
  /** Gets waiting on fetches; told once when auth flips to invalid. */
  readonly #waiters = new Set<() => void>();

  constructor(broadcast: (evt: Evt) => void) {
    this.#broadcast = broadcast;
  }

  /**
   * Calls `fn` once if auth flips to invalid; returns the unsubscribe, which
   * the waiter must call when its fetches finish so nothing accumulates.
   */
  onInvalid(fn: () => void): () => void {
    // Already invalid (a fetch may have failed synchronously before the
    // waiter subscribed): tell it now, nothing to hold.
    if (!this.#valid) {
      fn();
      return () => {};
    }
    this.#waiters.add(fn);
    return () => this.#waiters.delete(fn);
  }

  /** Gets currently waiting on fetches (diagnostics and tests). */
  get waiterCount(): number {
    return this.#waiters.size;
  }

  get valid(): boolean {
    return this.#valid;
  }

  /**
   * Flips to invalid; broadcasts authInvalid only on the first flip, with
   * the context the refused fetch was issued with (N33).
   */
  invalidate(error: { name: string; message: string }, context: unknown): void {
    if (!this.#valid) return;
    this.#valid = false;
    // Release gets that are waiting on fetches: they report auth-pending.
    for (const fn of [...this.#waiters]) fn();
    this.#waiters.clear();
    this.#broadcast({
      t: "evt",
      scope: "client",
      event: "authInvalid",
      payload: { error, context },
    });
  }

  /** New material arrived: fetches may resume. */
  restore(): void {
    this.#valid = true;
  }
}

/** How deep sameMaterial looks before it gives up (answers false). */
const MAX_DEPTH = 32;
/** How many members sameMaterial examines before it gives up (answers false). */
const MAX_MEMBERS = 10_000;

/** One comparison's state: see sameMaterial. */
interface Walk {
  /** The objects on the path being compared: meeting one again is a cycle. */
  readonly open: Set<object>;
  /** Pairs already proven the same, so a shared reference is walked once. */
  readonly proven: WeakMap<object, WeakSet<object>>;
  /** Members examined so far, against MAX_MEMBERS. */
  members: number;
}

/**
 * Whether two structured-cloned contexts are certainly the same material
 * (step 133): primitives by `Object.is`, plain arrays and plain objects
 * member by member, keys in any order. Anything else (a Map, a Date, a
 * typed array, a cycle, nesting deeper than MAX_DEPTH, more than
 * MAX_MEMBERS members in all) answers false, so the caller treats it as new
 * material, as §4.9 Loading does for every value that is not the identical
 * one. Structured clone keeps shared references, so a pair already proven
 * the same is not walked again: each pair of objects is expanded at most
 * once, and the members budget bounds the whole walk. It runs
 * synchronously in the worker that every tab shares.
 */
export function sameMaterial(a: unknown, b: unknown): boolean {
  return same(a, b, 0, { open: new Set(), proven: new WeakMap(), members: 0 });
}

function same(a: unknown, b: unknown, depth: number, walk: Walk): boolean {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (walk.proven.get(a)?.has(b) === true) return true;
  if (depth >= MAX_DEPTH || walk.open.has(a) || walk.open.has(b)) return false;
  if (!sameShape(a, b)) return false;
  return sameMembers(a, b, depth, walk);
}

/** Both plain arrays of one length, or both plain objects. */
function sameShape(a: object, b: object): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      (a as unknown[]).length === (b as unknown[]).length
    );
  }
  return isPlain(a) && isPlain(b);
}

/** The members of two objects of the same shape, within the walk's budget. */
function sameMembers(a: object, b: object, depth: number, walk: Walk): boolean {
  const keys = Object.keys(a);
  walk.members += keys.length;
  if (walk.members > MAX_MEMBERS) return false;
  if (keys.length !== Object.keys(b).length) return false;
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  walk.open.add(a);
  walk.open.add(b);
  let result: boolean;
  try {
    result = keys.every(
      (key) => Object.hasOwn(y, key) && same(x[key], y[key], depth + 1, walk),
    );
  } finally {
    walk.open.delete(a);
    walk.open.delete(b);
  }
  if (result) prove(a, b, walk);
  return result;
}

/** Records that `a` and `b` are the same, so the pair is not walked again. */
function prove(a: object, b: object, walk: Walk): void {
  const pairs = walk.proven.get(a) ?? new WeakSet<object>();
  pairs.add(b);
  walk.proven.set(a, pairs);
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
