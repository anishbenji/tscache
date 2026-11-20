import { expect, it } from "vitest";
import { Persister } from "../src/persist/persister";
import {
  batch,
  DAY,
  engine,
  HOUR,
  ID,
  NY,
  nyOffset,
  persisted,
  probe,
  span,
  utc,
} from "./calendar-contract-helpers";
import { fakeTime, finish } from "./persist-harness";
import { MemoryStore } from "./persist-memory-store";
import { requireCache } from "./persist-test-helpers";

// Implementer tests added after pre-review 1 and security lane 1 of step
// 129 (docs/reviews/step-129.md): each pins a behaviour that no test did.

fakeTime();

const daily = { unit: "day", zone: NY, at: "09:30" } as const;
const winter = () => -5 * HOUR;
const dailyStart = (slot: number) => slot * DAY + 14.5 * HOUR;
const march6 = utc("2026-03-06T14:30Z");

// B4 (architecture §4.10.5 step 2): a calendar cache sets a stored
// watermark its grid rejects aside and keeps the record's pages.
it.each([
  { name: "beyond Date's range", watermark: 9_000_000_000_000_000 },
  { name: "past the outer bound", watermark: utc("+010000-01-03T00:00Z") },
  { name: "in slot kMax + 1", watermark: utc("+010000-01-02T00:00Z") },
  { name: "before the domain", watermark: utc("0000-06-01T00:00Z") },
  { name: "NaN", watermark: Number.NaN },
  { name: "Infinity", watermark: Number.POSITIVE_INFINITY },
])(
  "B4: a stored watermark $name is set aside, and the page is applied and kept",
  async ({ watermark }) => {
    const writer = engine(daily, { persist: true }, probe(nyOffset).context);
    const source = await persisted(writer);
    writer.put(ID, batch([march6], [7]));
    await source.flush();
    const stored = source.records();
    expect(stored.pages).toHaveLength(1);

    const target = engine(daily, { persist: true }, probe(nyOffset).context);
    const disk = await persisted(target, {
      ...stored,
      cache: { ...requireCache(stored), finalizedUntil: watermark },
    });
    // The page was applied: its point and its coverage are read back.
    expect(target.get(ID, span(march6))).toEqual({
      timestamps: new Float64Array([march6]),
      fields: { value: new Float64Array([7]) },
      coverage: [span(march6)],
      misses: [],
    });
    expect(target.snapshot(ID, span(march6))).not.toHaveProperty(
      "finalizedUntil",
    );
    // The rewrite keeps the page and drops the watermark: the records are
    // those the writer stored.
    await disk.flush();
    expect(disk.records()).toEqual(stored);
  },
);

it.each([
  { name: "a string", watermark: "2026-03-06" },
  { name: "null", watermark: null },
])(
  "B4: a stored watermark that is $name still refuses the record",
  async ({ watermark }) => {
    const writer = engine(daily, { persist: true }, probe(nyOffset).context);
    const source = await persisted(writer);
    writer.put(ID, batch([march6], [7]));
    await source.flush();
    const stored = source.records();
    const target = engine(daily, { persist: true }, probe(nyOffset).context);
    const disk = await persisted(target, {
      ...stored,
      cache: {
        ...requireCache(stored),
        finalizedUntil: watermark as unknown as number,
      },
    });
    expect(target.get(ID, span(march6))).toMatchObject({
      timestamps: new Float64Array(),
      coverage: [],
    });
    await disk.flush();
    expect(disk.records()).toEqual({ cache: undefined, pages: [] });
  },
);

// Test 17, for a watermark that is set aside: it was converted once, so it
// counts 12 toward the load's budget, as an applied one does.
it.each([
  { budget: 156, kept: 2 },
  { budget: 155, kept: 1 },
])(
  "17: with a set-aside watermark a load with budget $budget keeps $kept newest pages",
  async ({ budget, kept }) => {
    const options = { persist: true, segmentSlotCap: 16 };
    const block = 40 * 512;
    const timestamps = [5, 21, 37].map((slot) => dailyStart(block + slot));
    const writer = engine(daily, options, probe(winter).context);
    const source = await persisted(writer);
    for (const t of timestamps) writer.put(ID, batch([t]));
    await source.flush();
    const stored = source.records();
    expect(stored.pages).toHaveLength(3);
    // Inside the outer bound and outside the domain: its conversion makes
    // lookups before it is refused.
    const outside = 2_932_897 * DAY + 20 * HOUR;
    const records = {
      ...stored,
      cache: { ...requireCache(stored), finalizedUntil: outside },
    };

    const { context, lookups } = probe(winter, { lookupBudget: budget });
    const reader = engine(daily, options, context);
    const store = new MemoryStore();
    store.seed(ID, records);
    const persister = new Persister(reader, async () => store);
    await persister.open(ID);
    expect(lookups.length).toBeLessThanOrEqual(12 + 72 * kept);
    const newest = timestamps.slice(-kept);
    expect(
      reader.get(ID, span(timestamps[0] as number, timestamps[2])),
    ).toMatchObject({
      timestamps: new Float64Array(newest),
      coverage: newest.map((t) => span(t)),
    });
    await finish(persister.flush(ID));
    expect(store.records(ID).pages).toEqual(stored.pages.slice(-kept));
    expect(store.records(ID).cache).not.toHaveProperty("finalizedUntil");
  },
);
