/**
 * The engine's memory budget (docs/architecture.md §2.9, §4.6; N86–N105): one
 * byte budget shared by every cache of an engine, enforced by evicting the
 * least recently used unpinned pages. Only an engine with a budget creates
 * one; without it no page is tracked, counted or pinned (§2.9, cost). No timer: the use order is insertion order, not a clock.
 */

import type { SlotRange } from "../grid";
import type { CacheMemory, CacheState } from "./cache";
import { pageOf, pageRange } from "./merge";

/** One page of one cache that holds points: a place in the use order. */
interface PageEntry {
  readonly state: CacheState;
  readonly page: number;
}

/** A pending orchestrated get's pin: its pages, first to last (N94). */
interface Pin {
  readonly first: number;
  readonly last: number;
}

export class MemoryBudget implements CacheMemory {
  /** The budget in bytes: a positive safe integer. */
  readonly budget: number;
  /** The bytes every cache's segments hold (N90), kept by the stores. */
  #bytes = 0;
  /**
   * Every page that holds points, least recently used first: a Set keeps
   * insertion order, and a use deletes and re-adds its entry (N92).
   */
  readonly #order = new Set<PageEntry>();
  /** Per cache, its entries by page. */
  readonly #pages = new Map<CacheState, Map<number, PageEntry>>();
  /** Per cache, the pins of its pending orchestrated gets (N94). */
  readonly #pins = new Map<CacheState, Pin[]>();
  #evictedPages = 0;
  /** Set while enforcement runs: an eviction's listener cannot nest one. */
  #enforcing = false;

  constructor(budget: number) {
    this.budget = budget;
  }

  /** Pages evicted since the budget took effect. */
  get evictedPages(): number {
    return this.#evictedPages;
  }

  /** Pages in the use order: every page of every cache that holds points. */
  get orderSize(): number {
    return this.#order.size;
  }

  counted(delta: number): void {
    this.#bytes += delta;
  }

  use(state: CacheState, slots: SlotRange, wrote: boolean): void {
    const cap = state.config.segmentSlotCap;
    const first = pageOf(slots.start, cap);
    const last = pageOf(slots.end, cap);
    const window = {
      start: pageRange(first, cap).start,
      end: pageRange(last, cap).end,
    };
    if (!wrote) {
      state.forEachPage(window, (page) => this.#touch(state, page));
      return;
    }
    const held = new Set<number>();
    state.forEachPage(window, (page) => {
      held.add(page);
      this.#touch(state, page);
    });
    this.#dropEmptied(state, first, last, held);
  }

  /**
   * Takes out of the order the pages from `first` to `last` that a write
   * emptied (an authority over them): every page there not in `held`.
   * Visits the fewer of the range's pages and the cache's entries.
   */
  #dropEmptied(
    state: CacheState,
    first: number,
    last: number,
    held: ReadonlySet<number>,
  ): void {
    const pages = this.#pages.get(state);
    if (pages === undefined || pages.size === held.size) return;
    const emptied = (page: number) =>
      page >= first && page <= last && !held.has(page);
    if (last - first + 1 <= pages.size) {
      for (let page = first; page <= last; page++) {
        const entry = pages.get(page);
        if (entry !== undefined && emptied(page)) this.#drop(entry);
      }
      return;
    }
    for (const [page, entry] of pages) if (emptied(page)) this.#drop(entry);
  }

  useAll(state: CacheState): void {
    state.forEachPage(undefined, (page) => this.#touch(state, page));
  }

  cleared(state: CacheState): void {
    const pages = this.#pages.get(state);
    if (pages === undefined) return;
    for (const entry of pages.values()) this.#order.delete(entry);
    this.#pages.delete(state);
  }

  /**
   * Pins the pages of `slots` in `state` until the returned release runs
   * (a pending orchestrated get, N94). The release is idempotent and ends in
   * enforcement, so what the pin held over the budget goes then.
   */
  pin(state: CacheState, slots: SlotRange): () => void {
    const cap = state.config.segmentSlotCap;
    const pin: Pin = {
      first: pageOf(slots.start, cap),
      last: pageOf(slots.end, cap),
    };
    const pins = this.#pins.get(state) ?? [];
    pins.push(pin);
    this.#pins.set(state, pins);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const list = this.#pins.get(state) as Pin[];
      list.splice(list.indexOf(pin), 1);
      if (list.length === 0) this.#pins.delete(state);
      this.settle();
    };
  }

  /**
   * Evicts the least recently used unpinned pages until the bytes are at
   * or below the budget or nothing evictable is left (§2.9). Each cache it
   * evicted from outside its own running call then reports once.
   */
  settle(): void {
    if (this.#bytes <= this.budget || this.#enforcing) return;
    this.#enforcing = true;
    const evictedFrom = new Set<CacheState>();
    try {
      for (const entry of this.#order) {
        if (this.#bytes <= this.budget) break;
        if (this.#pinned(entry)) continue;
        this.#drop(entry);
        const { state, page } = entry;
        // Defensive: a page without points is never evicted (N105).
        if (state.pageBytes(page) === 0) continue;
        state.evict(page);
        this.#evictedPages++;
        evictedFrom.add(state);
      }
    } finally {
      this.#enforcing = false;
      for (const state of evictedFrom) state.flushEvicted();
    }
  }

  /** Pages in the order that are pinned now (N93, N94). */
  pinnedPages(): number {
    let n = 0;
    for (const entry of this.#order) if (this.#pinned(entry)) n++;
    return n;
  }

  /** Bytes of the pages pinned now (`MemoryStats.pinnedBytes`). */
  pinnedBytes(): number {
    let bytes = 0;
    for (const entry of this.#order) {
      if (this.#pinned(entry)) {
        bytes += entry.state.pageBytes(entry.page);
      }
    }
    return bytes;
  }

  /** Moves a page that holds points to the most recent end of the order. */
  #touch(state: CacheState, page: number): void {
    let pages = this.#pages.get(state);
    if (pages === undefined) {
      pages = new Map();
      this.#pages.set(state, pages);
    }
    let entry = pages.get(page);
    if (entry === undefined) {
      entry = { state, page };
      pages.set(page, entry);
    } else {
      this.#order.delete(entry);
    }
    this.#order.add(entry);
  }

  #drop(entry: PageEntry): void {
    this.#order.delete(entry);
    const pages = this.#pages.get(entry.state);
    pages?.delete(entry.page);
    if (pages?.size === 0) this.#pages.delete(entry.state);
  }

  /** A provisional point (N93) or a pending get's pin (N94) holds the page. */
  #pinned({ state, page }: PageEntry): boolean {
    if (state.holdsProvisional(page)) return true;
    for (const pin of this.#pins.get(state) ?? []) {
      if (pin.first <= page && page <= pin.last) return true;
    }
    return false;
  }
}
