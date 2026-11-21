import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Announcement,
  Generations,
  outranks,
  sameGeneration,
} from "../src/rpc/generations";
import { clearPoster } from "../src/rpc/workers-channel";
import { rng } from "./cache-model";
import { fakeChannels } from "./workers-channel";

// Implementer tests for the workers' channel (docs/design/m5-deploy-skew.md
// §6 tests 11, 12, 14 and the posting half of 16; architecture §4.7,
// Generations; N127, N128, N135, N140). The rank and the same-generation
// rule are pure, so their tests are properties over seeded announcements.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const url = "https://app.example/dist/worker.js";

function worker(overrides: Partial<Announcement> = {}): Announcement {
  return { id: "w", lib: "0.3.0", url, startedAt: 1000, ...overrides };
}

const LIBS = [
  "0.2.0",
  "0.3.0-alpha",
  "0.3.0-alpha.1",
  "0.3.0-alpha.beta",
  "0.3.0-beta.2",
  "0.3.0-beta.11",
  "0.3.0-rc.1",
  "0.3.0",
  "0.9.0",
  "0.10.0",
  "1.0.0-0",
  "1.0.0",
];
const FETCHERS = [undefined, "/fetcher.js", "./fetcher.js", "/fetcher-b.js"];
// At the root, so that "./fetcher.js" and "/fetcher.js" are one module.
const ROOT = "https://app.example/worker.js";
const URLS = [ROOT, `${ROOT}?build=b`];

/** Announcements with distinct ids, the rest drawn from small sets. */
function announcements(seed: number, count: number): Announcement[] {
  const r = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const fetcher = r.pick(FETCHERS);
    return worker({
      id: `tscache-worker:${String(r.int(0, 9))}-${String(i)}`,
      lib: r.pick(LIBS),
      url: r.pick(URLS),
      startedAt: r.int(1, 4),
      ...(fetcher === undefined ? {} : { fetcher }),
    });
  });
}

describe("11: rank (N128)", () => {
  it("orders the library versions by semantic version, whatever the start times", () => {
    for (let low = 0; low < LIBS.length; low++) {
      for (let high = low + 1; high < LIBS.length; high++) {
        const older = worker({
          id: "z",
          lib: LIBS[low] as string,
          startedAt: 9,
        });
        const newer = worker({
          id: "a",
          lib: LIBS[high] as string,
          startedAt: 1,
        });
        expect([LIBS[high], outranks(newer, older)]).toEqual([
          LIBS[high],
          true,
        ]);
        expect([LIBS[low], outranks(older, newer)]).toEqual([LIBS[low], false]);
      }
    }
  });

  it("for one library takes the later start, and for one start the greater id", () => {
    const first = worker({ id: "b", startedAt: 1 });
    expect(outranks(worker({ id: "a", startedAt: 2 }), first)).toBe(true);
    expect(outranks(first, worker({ id: "a", startedAt: 2 }))).toBe(false);
    expect(outranks(worker({ id: "c", startedAt: 1 }), first)).toBe(true);
    expect(outranks(first, worker({ id: "c", startedAt: 1 }))).toBe(false);
    // Build metadata takes no part in the order: the start decides.
    const built = worker({ id: "a", lib: "0.3.0+build.7", startedAt: 2 });
    expect(outranks(built, first)).toBe(true);
    expect(outranks(first, built)).toBe(false);
  });

  it.each([1, 0xc0ffee, 0xdeadbeef])(
    "is a strict total order on workers with different ids (seed %i)",
    (seed) => {
      const workers = announcements(seed, 40);
      for (const a of workers) {
        expect(outranks(a, a)).toBe(false);
        for (const b of workers) {
          if (a === b) continue;
          // Antisymmetric and total: both sides of a pair agree on one winner.
          expect(outranks(a, b)).toBe(!outranks(b, a));
          for (const c of workers) {
            if (outranks(a, b) && outranks(b, c)) {
              expect(outranks(a, c)).toBe(true);
            }
          }
        }
      }
    },
  );
});

describe("12: same generation (N140)", () => {
  it.each([1, 0xc0ffee, 0xdeadbeef])(
    "holds exactly for one script, one library and compatible fetchers (seed %i)",
    (seed) => {
      const workers = announcements(seed, 40);
      // An independent oracle: both fetcher strings of the sets name one URL.
      const module = (w: Announcement) =>
        w.fetcher === undefined ? undefined : w.fetcher.replace(/^\.?\//, "");
      for (const a of workers) {
        for (const b of workers) {
          const fa = module(a);
          const fb = module(b);
          const expected =
            a.url === b.url &&
            a.lib === b.lib &&
            (fa === undefined || fb === undefined || fa === fb);
          expect(sameGeneration(a, b)).toBe(expected);
          expect(sameGeneration(b, a)).toBe(expected);
        }
      }
    },
  );

  it("takes two strings that resolve to one URL against the worker's as equal", () => {
    const a = worker({ id: "a", fetcher: "./fetcher.js" });
    const b = worker({ id: "b", fetcher: "/dist/fetcher.js" });
    expect(sameGeneration(a, b)).toBe(true);
    expect(sameGeneration(a, worker({ id: "c", fetcher: "/fetcher.js" }))).toBe(
      false,
    );
  });

  it("ranks two worker builds with one key: a different url is another generation", () => {
    const a = worker({ id: "a", fetcher: "/fetcher.js" });
    const b = worker({
      id: "b",
      fetcher: "/fetcher.js",
      url: `${url}?build=b`,
    });
    expect(sameGeneration(a, b)).toBe(false);
    expect(outranks(b, a)).toBe(true);
  });
});

/** A worker on the bus, with what its hooks were called with. */
function joined(
  bus: ReturnType<typeof fakeChannels>,
  self: Omit<Announcement, "fetcher">,
) {
  const superseded: string[] = [];
  const cleared: string[] = [];
  const generations = new Generations(bus.open(), self, {
    superseded: (lib) => superseded.push(lib),
    clearAll: (clearId) => cleared.push(clearId),
  });
  return { generations, superseded, cleared };
}

describe("14: announce and present (N127)", () => {
  it("posts one announce, with its url and resolved fetcher, at its first init and none later", () => {
    const bus = fakeChannels();
    const a = joined(
      bus,
      worker({ id: "a", name: "tscache:0.3.0:./fetcher.js" }),
    );
    expect(bus.posts).toEqual([]);
    a.generations.announce("./fetcher.js");
    a.generations.announce("./fetcher.js");
    a.generations.announce(undefined);
    expect(bus.posts).toEqual([
      {
        t: "announce",
        v: 1,
        id: "a",
        lib: "0.3.0",
        url,
        fetcher: "https://app.example/dist/fetcher.js",
        name: "tscache:0.3.0:./fetcher.js",
        startedAt: 1000,
      },
    ]);
  });

  it("announces no fetcher when its first connection named none", () => {
    const bus = fakeChannels();
    joined(bus, worker({ id: "a" })).generations.announce(undefined);
    expect(bus.posts).toEqual([
      { t: "announce", v: 1, id: "a", lib: "0.3.0", url, startedAt: 1000 },
    ]);
  });

  it("answers another worker's announce with one present, and never its own messages", () => {
    const bus = fakeChannels();
    const a = joined(bus, worker({ id: "a" }));
    a.generations.announce("/fetcher.js");
    const b = joined(bus, worker({ id: "b" }));
    b.generations.announce("/fetcher.js");
    expect(bus.posts.map(({ t, id }) => [t, id])).toEqual([
      ["announce", "a"],
      ["announce", "b"],
      ["present", "a"],
    ]);
    // Same generation: neither is superseded.
    expect([a.superseded, b.superseded]).toEqual([[], []]);
    // A message that carries the worker's own id is not answered or compared.
    const posted = (id: string) => bus.posts.filter((m) => m.id === id).length;
    const before = posted("b");
    bus.open().postMessage({ ...bus.posts[1], startedAt: 5000, lib: "9.0.0" });
    expect(posted("b")).toBe(before + 1);
    expect(b.superseded).toEqual([]);
  });

  it("neither answers nor compares before its own announce", () => {
    const bus = fakeChannels();
    const late = joined(bus, worker({ id: "late", lib: "0.2.0" }));
    const a = joined(bus, worker({ id: "a" }));
    a.generations.announce("/fetcher.js");
    expect(bus.posts.map(({ t, id }) => [t, id])).toEqual([["announce", "a"]]);
    expect(late.superseded).toEqual([]);

    // Its own announce brings the present of the worker that is running.
    late.generations.announce("/fetcher.js");
    expect(bus.posts.map(({ t, id }) => [t, id])).toEqual([
      ["announce", "a"],
      ["announce", "late"],
      ["present", "a"],
    ]);
    expect(late.superseded).toEqual(["0.3.0"]);
    expect(a.superseded).toEqual([]);
  });

  it("ignores a message with an unknown t or v, or a field of the wrong type", () => {
    const bus = fakeChannels();
    const a = joined(bus, worker({ id: "a" }));
    a.generations.announce("/fetcher.js");
    const before = bus.posts.length;
    const other = bus.open();
    const newer = {
      t: "announce",
      v: 1,
      id: "n",
      lib: "9.0.0",
      url,
      startedAt: 9,
    };
    for (const message of [
      null,
      "announce",
      { ...newer, v: 2 },
      { ...newer, t: "hello" },
      { ...newer, t: undefined },
      { ...newer, id: 7 },
      { ...newer, lib: 9 },
      { ...newer, url: undefined },
      { ...newer, startedAt: "9" },
      { ...newer, startedAt: Number.NaN },
      { t: "clearAll", v: 2, id: "n", clear: "x" },
      { t: "clearAll", v: 1, id: "n" },
      { t: "clearAll", v: 1, id: "n", clear: 7 },
      { t: "clearAll", v: 1, id: 7, clear: "x" },
    ]) {
      other.postMessage(message);
    }
    const answers = bus.posts
      .slice(before)
      .filter((m) => (m as { id?: unknown } | null)?.id === "a");
    expect(answers).toEqual([]);
    expect(a.superseded).toEqual([]);
    expect(a.cleared).toEqual([]);
    // The well-formed one is answered and supersedes.
    other.postMessage(newer);
    expect(bus.posts.at(-1)).toMatchObject({ t: "present", id: "a" });
    expect(a.superseded).toEqual(["9.0.0"]);
  });

  // Treated as absent, a malformed optional field would rank the sender as
  // another, newer generation and supersede this worker for its life (gate
  // round 3, R3-1). Each such message is ignored: not answered, not compared.
  it.each(
    ["announce", "present"].flatMap((t) =>
      [
        { fetcher: 123 },
        { fetcher: { href: "/fetcher.js" } },
        { fetcher: null },
        { name: 7 },
        { name: ["tscache:9.0.0:"] },
        { name: null },
      ].map((malformed) => ({ t, malformed })),
    ),
  )("ignores a $t with $malformed", ({ t, malformed }) => {
    const bus = fakeChannels();
    const a = joined(bus, worker({ id: "a" }));
    a.generations.announce("/fetcher.js");
    const before = bus.posts.length;
    const other = bus.open();
    const newer = { v: 1, id: "n", lib: "9.0.0", url, startedAt: 9 };
    other.postMessage({ ...newer, t, ...malformed });
    const answers = bus.posts
      .slice(before)
      .filter((m) => (m as { id?: unknown } | null)?.id === "a");
    expect(answers).toEqual([]);
    expect(a.superseded).toEqual([]);
    // The same message with both fields well formed is taken.
    other.postMessage({
      ...newer,
      t,
      fetcher: "/fetcher.js",
      name: "tscache:9.0.0:/fetcher.js",
    });
    expect(a.superseded).toEqual(["9.0.0"]);
  });

  it("is superseded once, by the first higher-ranked worker of another generation", () => {
    const bus = fakeChannels();
    const a = joined(bus, worker({ id: "a" }));
    a.generations.announce("/fetcher.js");
    const b = joined(bus, worker({ id: "b", startedAt: 2000 }));
    b.generations.announce("/fetcher-b.js");
    const c = joined(bus, worker({ id: "c", lib: "0.4.0", startedAt: 1 }));
    c.generations.announce("/fetcher-b.js");
    // b started later than a; c's library is higher than both.
    expect(a.superseded).toEqual(["0.3.0"]);
    expect(b.superseded).toEqual(["0.4.0"]);
    expect(c.superseded).toEqual([]);
  });

  it("warns once in development on a worker of its generation under another key, and sends no event", () => {
    vi.stubEnv("NODE_ENV", "development");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = fakeChannels();
    const a = joined(
      bus,
      worker({ id: "a", name: "tscache:0.3.0:/fetcher.js" }),
    );
    a.generations.announce("/fetcher.js");
    // A closing worker's successor has the same key: nothing to say.
    const successor = joined(
      bus,
      worker({ id: "s", name: "tscache:0.3.0:/fetcher.js", startedAt: 2000 }),
    );
    successor.generations.announce("/fetcher.js");
    expect(warn).not.toHaveBeenCalled();

    // A page without a fetcher has another key and is one generation.
    const plain = joined(
      bus,
      worker({ id: "p", name: "tscache:0.3.0:", startedAt: 3000 }),
    );
    plain.generations.announce(undefined);
    // a and its successor each warn of `plain`, and `plain` of the first it hears.
    expect(warn).toHaveBeenCalledTimes(3);
    expect(warn.mock.calls[0]?.[0]).toContain('"tscache:0.3.0:/fetcher.js"');
    expect(warn.mock.calls[0]?.[0]).toContain('"tscache:0.3.0:"');
    expect([a.superseded, successor.superseded, plain.superseded]).toEqual([
      [],
      [],
      [],
    ]);
    // Once per worker: a second such worker prints nothing more in `a`.
    const other = joined(
      bus,
      worker({ id: "q", name: "tscache:0.3.0:./fetcher.js", startedAt: 4000 }),
    );
    other.generations.announce("./fetcher.js");
    expect(warn).toHaveBeenCalledTimes(4);
  });

  it("prints nothing in a production build", () => {
    vi.stubEnv("NODE_ENV", "production");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bus = fakeChannels();
    joined(bus, worker({ id: "a", name: "one" })).generations.announce("/f.js");
    joined(bus, worker({ id: "b", name: "two" })).generations.announce(
      undefined,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("16: clearAll on the channel (N135)", () => {
  it("hands another worker's clear ids to the hook, before its own announce too, and not its own posts", () => {
    const bus = fakeChannels();
    const a = joined(bus, worker({ id: "a" }));
    const b = joined(bus, worker({ id: "b" }));
    b.generations.postClear("b:1");
    b.generations.postClear("b:1");
    expect(bus.posts).toEqual([
      { t: "clearAll", v: 1, id: "b", clear: "b:1" },
      { t: "clearAll", v: 1, id: "b", clear: "b:1" },
    ]);
    expect(a.cleared).toEqual(["b:1", "b:1"]);
    expect(b.cleared).toEqual([]);
  });

  it("a posting hosting opens the channel at the first post and closes it after the second", () => {
    const bus = fakeChannels();
    bus.install();
    const a = joined(bus, worker({ id: "a" }));
    const post = clearPoster();
    expect(bus.counts).toEqual({ opened: 1, open: 1 });

    post?.("logout");
    expect(bus.counts).toEqual({ opened: 2, open: 2 });
    post?.("other");
    expect(bus.counts).toEqual({ opened: 3, open: 3 });
    post?.("logout");
    expect(bus.counts).toEqual({ opened: 3, open: 2 });
    post?.("other");
    expect(bus.counts).toEqual({ opened: 3, open: 1 });

    expect(a.cleared).toEqual(["logout", "other", "logout", "other"]);
    const ids = new Set(bus.posts.map(({ id }) => id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{32}$/);
    // The next clear opens a channel of its own.
    post?.("again");
    expect(bus.counts).toEqual({ opened: 4, open: 2 });
  });

  it("there is no poster in a realm without BroadcastChannel", () => {
    expect(clearPoster()).toBeUndefined();
  });
});
