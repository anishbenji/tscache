import type { CacheRecord, PageRecord } from "../src/persist/records";
import type {
  PageRange,
  PersistStore,
  StoredCache,
  WritePlan,
} from "../src/persist/store";

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export type StoreKind = "read" | "write" | "clearAll";
export type StoreCall = (
  | { kind: "read"; cacheId: string; pages?: PageRange[] }
  | { kind: "write"; cacheId: string; plan: WritePlan }
  | { kind: "clearAll" }
) & { settled: boolean };

export interface StoreGate {
  entered: Promise<void>;
  release: () => void;
  reject: (error: unknown) => void;
}

/** The documented seam, with deterministic transaction order and no timers. */
export class MemoryStore implements PersistStore {
  readonly caches: Map<string, CacheRecord> = new Map();
  readonly pages: Map<string, Map<number, PageRecord>> = new Map();
  readonly log: StoreCall[] = [];
  private closed = false;
  private tail: Promise<void> = Promise.resolve();
  private failures = new Map<StoreKind, { left: number; error: Error }>();
  private gates = new Map<
    StoreKind,
    {
      entered: ReturnType<typeof deferred<void>>;
      done: ReturnType<typeof deferred<void>>;
    }[]
  >();

  fail(
    kind: StoreKind,
    count = 1,
    name = "UnknownError",
    message = "planted failure",
  ): void {
    this.failures.set(kind, {
      left: count,
      error: Object.assign(new Error(message), { name }),
    });
  }

  recover(kind: StoreKind): void {
    this.failures.delete(kind);
  }

  gate(kind: StoreKind): StoreGate {
    const entered = deferred<void>();
    const done = deferred<void>();
    // A gate may be rejected before its call reaches the commit queue.
    void done.promise.catch(() => {});
    const queue = this.gates.get(kind) ?? [];
    queue.push({ entered, done });
    this.gates.set(kind, queue);
    return {
      entered: entered.promise,
      release: () => done.resolve(),
      reject: (e) => done.reject(e),
    };
  }

  seed(cacheId: string, records: StoredCache): void {
    this.caches.delete(cacheId);
    if (records.cache !== undefined)
      this.caches.set(cacheId, structuredClone(records.cache));
    this.pages.set(
      cacheId,
      new Map(
        records.pages.map((page: PageRecord) => [
          page.page,
          structuredClone(page),
        ]),
      ),
    );
  }

  records(cacheId: string): StoredCache {
    return structuredClone({
      cache: this.caches.get(cacheId),
      pages: [...(this.pages.get(cacheId)?.values() ?? [])].sort(
        (a, b) => a.page - b.page,
      ),
    });
  }

  private start(call: StoreCall): {
    wait: Promise<void>;
    error: Error | undefined;
  } {
    this.log.push(call);
    const gate = this.gates.get(call.kind)?.shift();
    gate?.entered.resolve();
    const failure = this.failures.get(call.kind);
    let error: Error | undefined;
    if (failure !== undefined && failure.left > 0) {
      failure.left--;
      error = failure.error;
    }
    return { wait: gate?.done.promise ?? Promise.resolve(), error };
  }

  async read(cacheId: string, pages?: PageRange[]): Promise<StoredCache> {
    if (this.closed)
      throw new DOMException("Store closed", "InvalidStateError");
    const call: StoreCall =
      pages === undefined
        ? { kind: "read", cacheId, settled: false }
        : {
            kind: "read",
            cacheId,
            pages: structuredClone(pages),
            settled: false,
          };
    const { wait, error } = this.start(call);
    // Earlier write transactions commit first. Capture before any later write;
    // the read gate delays delivery, not the snapshot's transaction boundary.
    const snapshot = this.tail.then(() => this.records(cacheId));
    try {
      await wait;
      if (error !== undefined) throw error;
      const records = await snapshot;
      return {
        cache: records.cache,
        pages: records.pages.filter(
          (p: PageRecord) =>
            pages === undefined ||
            pages.some((r) => r.start <= p.page && p.page <= r.end),
        ),
      };
    } finally {
      call.settled = true;
    }
  }

  async write(cacheId: string, plan: WritePlan): Promise<void> {
    if (this.closed)
      throw new DOMException("Store closed", "InvalidStateError");
    // Clone the entire plan before changing maps: DataCloneError is atomic.
    let copy: WritePlan;
    try {
      copy = structuredClone(plan);
    } catch (error) {
      this.log.push({ kind: "write", cacheId, plan, settled: true });
      throw error;
    }
    const call: StoreCall = {
      kind: "write",
      cacheId,
      plan: copy,
      settled: false,
    };
    const { wait, error } = this.start(call);
    const operation = this.tail.then(async () => {
      await wait;
      if (error !== undefined) throw error;
      const next = new Map(this.pages.get(cacheId));
      for (const page of next.keys())
        if (
          copy.deletePages.some(
            (r: PageRange) => r.start <= page && page <= r.end,
          )
        )
          next.delete(page);
      for (const page of copy.putPages)
        next.set(page.page, structuredClone(page));
      this.pages.set(cacheId, next);
      if (copy.putCache === null) this.caches.delete(cacheId);
      else this.caches.set(cacheId, structuredClone(copy.putCache));
    });
    this.tail = operation.catch(() => {});
    try {
      await operation;
    } finally {
      call.settled = true;
    }
  }

  async clearAll(): Promise<void> {
    if (this.closed)
      throw new DOMException("Store closed", "InvalidStateError");
    const call: StoreCall = { kind: "clearAll", settled: false };
    const { wait, error } = this.start(call);
    const operation = this.tail.then(async () => {
      await wait;
      if (error !== undefined) throw error;
      this.caches.clear();
      this.pages.clear();
    });
    this.tail = operation.catch(() => {});
    try {
      await operation;
    } finally {
      call.settled = true;
    }
  }

  close(): void {
    this.closed = true;
  }
}
