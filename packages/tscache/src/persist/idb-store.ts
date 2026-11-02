/**
 * The IndexedDB adapter of the store seam (docs/architecture.md §4.10.2,
 * §4.10.3): one database per origin, `tscache` at version 1, with the
 * object stores `caches` (key path 'cacheId') and `pages` (key path
 * ['cacheId', 'page']), no indexes.
 *
 * Page ranges are walked with a cursor rather than an `IDBKeyRange`: the
 * adapter then needs nothing from its realm but the factory it is given,
 * and the conformance suite runs the same code as a browser.
 */

import type { CacheRecord, PageRecord } from "./records";
import type { PageRange, PersistStore, StoredCache, WritePlan } from "./store";

const DATABASE = "tscache";
const VERSION = 1;
const CACHES = "caches";
const PAGES = "pages";

/** The whole page range of a cache. */
const EVERY_PAGE: PageRange[] = [{ start: -Infinity, end: Infinity }];

function closed(): DOMException {
  return new DOMException(
    "the persistence store is closed",
    "InvalidStateError",
  );
}

/** The ranges sorted and merged, so a cursor walks each page once. */
function merged(ranges: readonly PageRange[]): PageRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: PageRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last !== undefined && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/**
 * Walks the page records of `cacheId` whose page lies in one of `ranges`
 * (merged, ascending), in key order, calling `visit` on each; `done` runs
 * once the walk is over. Positions the cursor with `continue(key)`, which
 * seeks, so pages outside the ranges and other caches are not visited.
 */
function walkPages(
  store: IDBObjectStore,
  cacheId: string,
  ranges: readonly PageRange[],
  visit: (cursor: IDBCursorWithValue) => void,
  done: () => void,
): void {
  if (ranges.length === 0) {
    done();
    return;
  }
  let at = 0;
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) {
      done();
      return;
    }
    const [id, page] = cursor.key as [string, number];
    if (id < cacheId) {
      cursor.continue([cacheId, (ranges[at] as PageRange).start]);
      return;
    }
    while (
      id === cacheId &&
      at < ranges.length &&
      page > (ranges[at] as PageRange).end
    ) {
      at++;
    }
    const range = ranges[at];
    if (id !== cacheId || range === undefined) {
      done();
      return;
    }
    if (page < range.start) {
      cursor.continue([cacheId, range.start]);
      return;
    }
    visit(cursor);
    cursor.continue();
  };
}

/**
 * A transaction's outcome: its own error, or the one that made us abort it.
 * A failed request is left uncanceled, so IndexedDB aborts the transaction
 * and nothing of it commits; the error then reaches us through onabort.
 */
function settled(tx: IDBTransaction, failure: () => unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure() ?? tx.error);
  });
}

class IdbStore implements PersistStore {
  #db: IDBDatabase | undefined;

  constructor(db: IDBDatabase) {
    this.#db = db;
    // A newer deploy's upgrade must not be blocked by this connection (§4.10.3).
    db.onversionchange = () => this.close();
    db.onclose = () => {
      this.#db = undefined;
    };
  }

  #database(): IDBDatabase {
    if (this.#db === undefined) throw closed();
    return this.#db;
  }

  async read(cacheId: string, pages?: PageRange[]): Promise<StoredCache> {
    const tx = this.#database().transaction([CACHES, PAGES], "readonly");
    const cache = tx.objectStore(CACHES).get(cacheId);
    const found: PageRecord[] = [];
    walkPages(
      tx.objectStore(PAGES),
      cacheId,
      merged(pages ?? EVERY_PAGE),
      (cursor) => found.push(cursor.value as PageRecord),
      () => {},
    );
    await settled(tx, () => undefined);
    return { cache: cache.result as CacheRecord | undefined, pages: found };
  }

  async write(cacheId: string, plan: WritePlan): Promise<void> {
    const tx = this.#database().transaction([CACHES, PAGES], "readwrite", {
      durability: plan.strict ? "strict" : "relaxed",
    });
    let failure: unknown;
    const outcome = settled(tx, () => failure);
    const pages = tx.objectStore(PAGES);
    const caches = tx.objectStore(CACHES);
    // The puts are made now, so IndexedDB clones the records while the
    // caller still holds them unchanged. The deletion walk, whose requests
    // run after them, then spares the pages just put: the outcome is that of
    // deletions, then page puts, then the cache record.
    const put = new Set<number>();
    try {
      for (const page of plan.putPages) {
        pages.put(page);
        put.add(page.page);
      }
      if (plan.putCache === null) caches.delete(cacheId);
      else caches.put(plan.putCache);
    } catch (error) {
      // A record that cannot be cloned: none of the plan may land.
      failure = error;
      tx.abort();
      await outcome;
      return;
    }
    walkPages(
      pages,
      cacheId,
      merged(plan.deletePages),
      (cursor) => {
        if (!put.has((cursor.key as [string, number])[1])) cursor.delete();
      },
      () => {},
    );
    await outcome;
  }

  async clearAll(): Promise<void> {
    const tx = this.#database().transaction([CACHES, PAGES], "readwrite", {
      durability: "strict",
    });
    const outcome = settled(tx, () => undefined);
    tx.objectStore(CACHES).clear();
    tx.objectStore(PAGES).clear();
    await outcome;
  }

  close(): void {
    this.#db?.close();
    this.#db = undefined;
  }
}

/**
 * Whether `factory` lists a database named `name`. A browser without
 * `databases()` cannot tell; the database is then opened, and created.
 */
async function exists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases !== "function") return true;
  const list = await factory.databases();
  return list.some((info) => info.name === name);
}

function open(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, VERSION);
    // Version 0 → 1 (§4.10.2); a later layout bumps the version and
    // migrates here.
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore(CACHES, { keyPath: "cacheId" });
      db.createObjectStore(PAGES, { keyPath: ["cacheId", "page"] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = (event) => {
      event.preventDefault?.();
      reject(request.error);
    };
  });
}

/**
 * Opens the database through `factory`, creating or upgrading it (§4.10.2).
 * With `ifExists`, resolves undefined and creates nothing when
 * `factory.databases()` does not list it. Rejects when it cannot be opened,
 * with a `VersionError` when a newer deploy has upgraded it.
 */
export async function openIdbStore(
  factory: IDBFactory,
  options: { name?: string; ifExists?: boolean } = {},
): Promise<PersistStore | undefined> {
  const name = options.name ?? DATABASE;
  if (options.ifExists === true && !(await exists(factory, name))) {
    return undefined;
  }
  return new IdbStore(await open(factory, name));
}
