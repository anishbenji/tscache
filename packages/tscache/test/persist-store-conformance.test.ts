import { describe, expect, it } from "vitest";
import type { PageRecord } from "../src/persist/records";
import type { PersistStore, WritePlan } from "../src/persist/store";
import { MemoryStore } from "./persist-memory-store";
import {
  allPages,
  fixture,
  requireCache,
  requirePage,
} from "./persist-test-helpers";

async function idbFactory(): Promise<IDBFactory> {
  const { IDBFactory: Factory } = await import("fake-indexeddb");
  return new Factory();
}
async function openIdbStore(
  factory: IDBFactory,
  options?: { name?: string; ifExists?: boolean },
): Promise<PersistStore | undefined> {
  const adapter = await import("../src/persist/idb-store");
  return adapter.openIdbStore(factory, options);
}

function conformance(label: string, make: () => Promise<PersistStore>): void {
  describe(`${label}: PersistStore §4.10.3`, () => {
    it("unknown reads empty; records, negative pages, masks, buffers and NaN survive", async () => {
      const s = await make();
      try {
        expect(await s.read("missing")).toEqual({
          cache: undefined,
          pages: [],
        });
        const data = fixture({}, [-1, 0, 4]);
        const page = requirePage(data, 1);
        const field = page.snapshot.segments[0]?.fields[0];
        if (field === undefined) throw new Error("fixture missing field");
        new Float64Array(field.data)[0] = Number.NaN;
        await s.write("persist", {
          deletePages: [],
          putPages: [...data.pages].reverse(),
          putCache: requireCache(data),
          strict: false,
        });
        expect(await s.read("persist")).toEqual(data);
        expect(
          (await s.read("persist")).pages.map((p: PageRecord) => p.page),
        ).toEqual([-1, 0, 1]);
        expect(
          requirePage(await s.read("persist"), 1).snapshot.segments[0]?.mask,
        ).toBeInstanceOf(Uint8Array);
        expect(
          requirePage(await s.read("persist"), 1).snapshot.segments[0]
            ?.fields[0]?.data,
        ).toBeInstanceOf(ArrayBuffer);
      } finally {
        s.close();
      }
    });
    it("page ranges include both ends, infinities and each overlap only once", async () => {
      const s = await make();
      try {
        const data = fixture({}, [-8, -4, 0, 4, 8]);
        await s.write("persist", {
          deletePages: [],
          putPages: data.pages,
          putCache: requireCache(data),
          strict: false,
        });
        for (const [ranges, expected] of [
          [[{ start: -1, end: 1 }], [-1, 0, 1]],
          [
            [
              { start: -Infinity, end: -1 },
              { start: -1, end: 0 },
            ],
            [-2, -1, 0],
          ],
          [[{ start: 1, end: Infinity }], [1, 2]],
          [[], []],
        ] as const)
          expect(
            (await s.read("persist", [...ranges])).pages.map(
              (p: PageRecord) => p.page,
            ),
          ).toEqual(expected);
        await s.write("persist", {
          deletePages: [{ start: -1, end: 0 }],
          putPages: [requirePage(data, 2)],
          putCache: requireCache(data),
          strict: true,
        });
        expect(
          (await s.read("persist")).pages.map((p: PageRecord) => p.page),
        ).toEqual([-2, 0, 1, 2]);
      } finally {
        s.close();
      }
    });
    it("deletes then replaces pages atomically, null deletes the cache only; other ids stay", async () => {
      const s = await make();
      try {
        const a = fixture();
        const b = fixture({ id: "other" });
        for (const [id, data] of [
          ["persist", a],
          ["other", b],
        ] as const)
          await s.write(id, {
            deletePages: [],
            putPages: data.pages,
            putCache: requireCache(data),
            strict: false,
          });
        const replacement = requirePage(a, 1);
        await s.write("persist", {
          deletePages: allPages,
          putPages: [replacement],
          putCache: null,
          strict: true,
        });
        expect(await s.read("persist")).toEqual({
          cache: undefined,
          pages: [replacement],
        });
        expect(await s.read("other")).toEqual(b);
        await s.clearAll();
        expect(await s.read("persist")).toEqual({
          cache: undefined,
          pages: [],
        });
        expect(await s.read("other")).toEqual({ cache: undefined, pages: [] });
      } finally {
        s.close();
      }
    });
    it("DataCloneError stores none of a plan, including its preceding deletions", async () => {
      const s = await make();
      try {
        const data = fixture();
        await s.write("persist", {
          deletePages: [],
          putPages: data.pages,
          putCache: requireCache(data),
          strict: false,
        });
        const bad = { ...requireCache(data), uncloneable: () => {} };
        await expect(
          s.write("persist", {
            deletePages: allPages,
            putPages: [],
            putCache: bad,
            strict: true,
          }),
        ).rejects.toMatchObject({ name: "DataCloneError" });
        expect(await s.read("persist")).toEqual(data);
      } finally {
        s.close();
      }
    });
    it("copies inputs at write and outputs at read", async () => {
      const s = await make();
      try {
        const data = fixture();
        const expected = structuredClone(data);
        const plan: WritePlan = {
          deletePages: [],
          putPages: data.pages,
          putCache: requireCache(data),
          strict: false,
        };
        const pending = s.write("persist", plan);
        requireCache(data).config.interval = 17;
        requirePage(data).snapshot.coverage.length = 0;
        await pending;
        expect(await s.read("persist")).toEqual(expected);
        const output = await s.read("persist");
        requirePage(output).snapshot.segments[0]?.mask?.fill(0);
        const field = requirePage(output).snapshot.segments[0]?.fields[0];
        if (field !== undefined) new Uint8Array(field.data).fill(0);
        requireCache(output).config.fields.value = "i8";
        expect(await s.read("persist")).toEqual(expected);
        // With deletions the store has a walk to make before its puts; the
        // inputs are still copied when write() is called, not when it ends.
        const replacement = structuredClone(requirePage(expected, 1));
        const cache = structuredClone(requireCache(expected));
        const replaced = {
          cache: structuredClone(cache),
          pages: [structuredClone(replacement)],
        };
        const replacing = s.write("persist", {
          deletePages: allPages,
          putPages: [replacement],
          putCache: cache,
          strict: true,
        });
        cache.config.interval = 17;
        replacement.snapshot.coverage.length = 0;
        replacement.snapshot.segments[0]?.mask?.fill(0);
        await replacing;
        expect(await s.read("persist")).toEqual(replaced);
      } finally {
        s.close();
      }
    });
    it("close makes read/write/clearAll reject InvalidStateError", async () => {
      const s = await make();
      s.close();
      await expect(s.read("persist")).rejects.toMatchObject({
        name: "InvalidStateError",
      });
      await expect(
        s.write("persist", {
          deletePages: [],
          putPages: [],
          putCache: null,
          strict: true,
        }),
      ).rejects.toMatchObject({ name: "InvalidStateError" });
      await expect(s.clearAll()).rejects.toMatchObject({
        name: "InvalidStateError",
      });
    });
  });
}
conformance("MemoryStore", async () => new MemoryStore());
conformance("IndexedDB", async () => {
  const store = await openIdbStore(await idbFactory());
  if (store === undefined) throw new Error("normal open must return store");
  return store;
});
function database(
  factory: IDBFactory,
  name: string,
  version: number,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name, version);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
describe("IndexedDB layout and lifecycle (§4.10.2–3)", () => {
  it.each([undefined, "custom-persist"])(
    "uses database %s, version 1 and exact unindexed key paths",
    async (name) => {
      const factory = await idbFactory();
      const store = await openIdbStore(
        factory,
        name === undefined ? undefined : { name },
      );
      const db = await database(factory, name ?? "tscache", 1);
      try {
        expect(db.name).toBe(name ?? "tscache");
        expect(db.version).toBe(1);
        expect([...db.objectStoreNames]).toEqual(["caches", "pages"]);
        const tx = db.transaction(["caches", "pages"]);
        expect(tx.objectStore("caches").keyPath).toBe("cacheId");
        expect(tx.objectStore("pages").keyPath).toEqual(["cacheId", "page"]);
        expect([...tx.objectStore("pages").indexNames]).toEqual([]);
        expect([...tx.objectStore("caches").indexNames]).toEqual([]);
      } finally {
        db.close();
        store?.close();
      }
    },
  );
  it("ifExists creates nothing; an existing database opens", async () => {
    const factory = await idbFactory();
    expect(await openIdbStore(factory, { ifExists: true })).toBeUndefined();
    expect(await factory.databases()).toEqual([]);
    const first = await openIdbStore(factory);
    first?.close();
    const second = await openIdbStore(factory, { ifExists: true });
    expect(second).toBeDefined();
    second?.close();
  });
  it("a newer database rejects VersionError", async () => {
    const factory = await idbFactory();
    (await database(factory, "tscache", 2)).close();
    await expect(openIdbStore(factory)).rejects.toMatchObject({
      name: "VersionError",
    });
  });
  it("versionchange closes the old store so an upgrade completes", async () => {
    const factory = await idbFactory();
    const store = await openIdbStore(factory);
    const newer = await database(factory, "tscache", 2);
    try {
      await expect(store?.read("persist")).rejects.toMatchObject({
        name: "InvalidStateError",
      });
    } finally {
      newer.close();
      store?.close();
    }
  });
});

describe("IndexedDB request failures (§4.10.3)", () => {
  it("an asynchronous request failure aborts the whole write, deletions included", async () => {
    const { IDBObjectStore: Store } = await import("fake-indexeddb");
    const store = await openIdbStore(await idbFactory());
    if (store === undefined) throw new Error("normal open must return store");
    const put = Store.prototype.put;
    try {
      const data = fixture();
      await store.write("persist", {
        deletePages: [],
        putPages: data.pages,
        putCache: requireCache(data),
        strict: false,
      });
      // One page put becomes an add of a key that exists: the request fails
      // asynchronously with a ConstraintError, after the deletions ran.
      let injected = false;
      Store.prototype.put = function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === "pages" && !injected) {
          injected = true;
          return this.add(value, key);
        }
        return put.call(this, value, key);
      } as typeof put;
      await expect(
        store.write("persist", {
          deletePages: [{ start: -1, end: 0 }],
          putPages: [requirePage(data, 2)],
          putCache: { ...requireCache(data), version: "next" },
          strict: true,
        }),
      ).rejects.toMatchObject({ name: "ConstraintError" });
      expect(injected).toBe(true);
      Store.prototype.put = put;
      expect(await store.read("persist")).toEqual(data);
    } finally {
      Store.prototype.put = put;
      store.close();
    }
  });
});

describe("MemoryStore controls used by the contracts (§4.10.3)", () => {
  it("injects the next n failures, then recovers; every-call failures are explicit", async () => {
    const s = new MemoryStore();
    s.fail("read", 2, "SecurityError", "denied");
    for (let i = 0; i < 2; i++)
      await expect(s.read("persist")).rejects.toMatchObject({
        name: "SecurityError",
        message: "denied",
      });
    expect(await s.read("persist")).toEqual({ cache: undefined, pages: [] });
    s.fail("clearAll", Infinity);
    for (let i = 0; i < 3; i++)
      await expect(s.clearAll()).rejects.toMatchObject({
        name: "UnknownError",
      });
    s.recover("clearAll");
    await s.clearAll();
    expect(s.log.map((c) => c.kind)).toEqual([
      "read",
      "read",
      "read",
      "clearAll",
      "clearAll",
      "clearAll",
      "clearAll",
    ]);
  });
  it("read gates hold the captured records; late results cannot read a later rewrite", async () => {
    const s = new MemoryStore();
    s.seed("persist", fixture({}, [0]));
    const gate = s.gate("read");
    const reading = s.read("persist");
    await gate.entered;
    await s.clearAll();
    gate.release();
    expect(await reading).toEqual(fixture({}, [0]));
    expect(s.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
  it("a cleanup queued after a held abandoned write commits after it", async () => {
    const s = new MemoryStore();
    const data = fixture({}, [0]);
    const gate = s.gate("write");
    const old = s.write("persist", {
      deletePages: [],
      putPages: data.pages,
      putCache: requireCache(data),
      strict: false,
    });
    await gate.entered;
    const cleanup = s.write("persist", {
      deletePages: allPages,
      putPages: [],
      putCache: null,
      strict: true,
    });
    expect(
      s.log.filter((c) => c.kind === "write").every((c) => !c.settled),
    ).toBe(true);
    gate.release();
    await Promise.all([old, cleanup]);
    expect(s.records("persist")).toEqual({ cache: undefined, pages: [] });
  });
  it("a gate can reject a chosen call without changing records", async () => {
    const s = new MemoryStore();
    const data = fixture({}, [0]);
    s.seed("persist", data);
    const gate = s.gate("clearAll");
    const clearing = s.clearAll();
    const rejection = expect(clearing).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
    await gate.entered;
    gate.reject(new DOMException("quota", "QuotaExceededError"));
    await rejection;
    expect(s.records("persist")).toEqual(data);
  });
});
