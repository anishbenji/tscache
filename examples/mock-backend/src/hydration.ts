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
} from "tscache";

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

/** The value a jsonScript() element carries in this page. */
export function readJson<T>(id: string): T {
  const text = document.getElementById(id)?.textContent;
  if (text == null) {
    throw new Error(`the page has no #${id}; was it server-rendered?`);
  }
  return JSON.parse(text) as T;
}

/** The hydration as a script element for the page's head. */
export function hydrationScript(hydration: Hydration): string {
  return jsonScript(HYDRATION_ELEMENT, hydration);
}

/** The hydration the server wrote into this page. */
export function readHydration(): Hydration {
  return readJson<Hydration>(HYDRATION_ELEMENT);
}

/**
 * Applies the server's snapshot to `cache`; every client may, since a
 * stale versioned snapshot is refused and covered slots are never touched.
 * A worker from before `hydrate` answers "unknown op": the cache then
 * fetches what it is asked for, so that counts as nothing applied. Any other
 * failure (a snapshot for another grid, say) is a bug and propagates.
 */
export async function seed(
  cache: CacheHandle,
  { snapshot }: Hydration,
): Promise<HydrateResult> {
  try {
    return await cache.hydrate(decodeSnapshot(snapshot));
  } catch (error) {
    if (error instanceof Error && /unknown op/.test(error.message)) {
      return { applied: [] };
    }
    throw error;
  }
}
