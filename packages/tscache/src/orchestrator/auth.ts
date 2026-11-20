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

/**
 * Whether two structured-cloned contexts are certainly the same material
 * (step 133): primitives by `Object.is`, plain arrays and plain objects
 * member by member, keys in any order. Anything else (a Map, a Date, a
 * typed array, a cycle, a structure deeper than MAX_DEPTH) answers false,
 * so the caller treats it as new material, as §4.9 Loading does for every
 * value that is not the identical one.
 */
export function sameMaterial(a: unknown, b: unknown): boolean {
  return same(a, b, new Set(), 0);
}

function same(
  a: unknown,
  b: unknown,
  open: Set<object>,
  depth: number,
): boolean {
  if (Object.is(a, b)) return true;
  if (!isObject(a) || !isObject(b)) return false;
  if (depth >= MAX_DEPTH || open.has(a) || open.has(b)) return false;
  const arrays = Array.isArray(a);
  if (arrays !== Array.isArray(b)) return false;
  if (!arrays && (!isPlain(a) || !isPlain(b))) return false;
  if (arrays && (a as unknown[]).length !== (b as unknown[]).length)
    return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  open.add(a);
  open.add(b);
  try {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    return keys.every(
      (key) => Object.hasOwn(y, key) && same(x[key], y[key], open, depth + 1),
    );
  } finally {
    open.delete(a);
    open.delete(b);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isPlain(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
