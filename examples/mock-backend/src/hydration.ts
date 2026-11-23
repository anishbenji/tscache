// SSR hydration with tscache's snapshot API (docs/architecture.md §2.8). The
// server reads a range with an in-process client and `get(range, {
// snapshot: true })`, and writes the encoded snapshot into the HTML. The
// browser decodes it and calls `hydrate`, which fills only what its cache
// neither covers nor holds as provisional, refuses a snapshot of another
// dataset version, and leaves the snapshot's provisional tail for the
// browser to fetch.

import {
  type CacheHandle,
  decodeSnapshot,
  type EncodedSnapshot,
  encodeSnapshot,
  type GetResult,
  type HydrateResult,
  type Range,
  type Snapshot,
  TscacheError,
} from "@anishbenji/tscache";

/** What the server read: the range it asked for and its snapshot. */
export interface Hydration {
  range: Range;
  snapshot: EncodedSnapshot;
}

/** The id of the script element that carries the hydration. */
export const HYDRATION_ELEMENT = "tscache-hydration";

/** The snapshot a `get(range, { snapshot: true })` result carries. */
export function snapshotOf(result: GetResult): Snapshot {
  if (result.snapshot === undefined) {
    throw new Error("the read carries no snapshot; pass { snapshot: true }");
  }
  return result.snapshot;
}

/** The server's snapshot of `range`, as the page carries it. */
export function dehydrate(range: Range, snapshot: Snapshot): Hydration {
  return { range, snapshot: encodeSnapshot(snapshot) };
}

/**
 * `value` as a JSON script element for the page's head. Every `<` in the
 * JSON is escaped, so no string in it can end the element early.
 */
export function jsonScript(id: string, value: unknown): string {
  const json = JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<script id="${id}" type="application/json">${json}</script>`;
}

/** The text of a jsonScript() element of this page. */
function textOf(id: string): string {
  const text = document.getElementById(id)?.textContent;
  if (text == null) {
    throw new Error(`the page has no #${id}; was it server-rendered?`);
  }
  return text;
}

/** The value a jsonScript() element carries in this page. */
export function readJson<T>(id: string): T {
  return JSON.parse(textOf(id)) as T;
}

/** The hydration as a script element for the page's head. */
export function hydrationScript(hydration: Hydration): string {
  return jsonScript(HYDRATION_ELEMENT, hydration);
}

/**
 * The hydration the server wrote into this page. A page without the
 * element throws here; its text is parsed when `range` or `snapshot` is
 * first read, not here. The page mounts without it, so text that is not
 * JSON (a truncated response, say) must count as "not seeded" like any
 * snapshot that fails to apply (architecture §2.8), rather than stop the
 * page: `seedCache` reads `snapshot` inside its own call. Reading either
 * then throws the SyntaxError, each time; a parsed value is kept.
 */
export function readHydration(): Hydration {
  const text = textOf(HYDRATION_ELEMENT);
  let parsed: Hydration | undefined;
  const value = (): Hydration => {
    parsed ??= JSON.parse(text) as Hydration;
    return parsed;
  };
  return {
    get range() {
      return value().range;
    },
    get snapshot() {
      return value().snapshot;
    },
  };
}

/**
 * What a warning says of `error`: its name, and a TscacheError's `code` when
 * it has one. Never its message, which can quote the snapshot it refused
 * (`decodeSnapshot` quotes one that is not an object, `JSON.parse` the text
 * it stopped at), and the snapshot carries the page's data.
 */
function nameOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code: unknown =
    error instanceof TscacheError
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? `${error.name} ${code}` : error.name;
}

/**
 * Applies the server's snapshot to `cache`; every client may, since a
 * stale versioned snapshot is refused and covered slots are never touched.
 * A worker from before `hydrate` answers "unknown op": the cache then
 * fetches what it is asked for, so that counts as nothing applied. Any other
 * failure (a snapshot for another grid, a hydration that is not JSON, say)
 * propagates; `seedCache` counts it as "not seeded" too (architecture §2.8).
 */
export async function seed(
  cache: CacheHandle,
  hydration: Hydration,
): Promise<HydrateResult> {
  try {
    return await cache.hydrate(decodeSnapshot(hydration.snapshot));
  } catch (error) {
    // Exactly the RPC server's answer to an op it lacks (§4.7).
    if (
      error instanceof TscacheError &&
      error.message === "unknown op hydrate"
    ) {
      return { applied: [] };
    }
    throw error;
  }
}

/**
 * Applies the server's snapshot to `cache` and returns the ranges it
 * filled, or undefined when the snapshot was not applied. A snapshot that
 * fails to apply (a malformed or foreign one, a failed write) only means
 * the cache is not seeded: hydration saves fetches, it is never needed for
 * correct answers (architecture §2.8), so the cache fetches what it lacks
 * instead. A development build says why, with the error's name only
 * (`nameOf`: its message can quote the snapshot, which carries the page's
 * data), and only while `live` holds: a
 * lost or disposed client fails every pending call, `hydrate` included, and
 * that is no news about the snapshot. `live` is asked after the failure, so
 * a client lost while `hydrate` was pending counts as lost.
 */
export async function seedCache(
  cache: CacheHandle,
  hydration: Hydration,
  live: () => boolean,
): Promise<Range[] | undefined> {
  try {
    return (await seed(cache, hydration)).applied;
  } catch (error) {
    if (import.meta.env.DEV && live()) {
      const why = nameOf(error);
      console.warn(
        `tscache: the server's snapshot for cache "${cache.id}" was not applied (${why}), so the cache fetches that range instead; printed in development builds only.`,
      );
    }
    return undefined;
  }
}
