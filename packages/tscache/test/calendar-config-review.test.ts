import { expect, it } from "vitest";
import { Engine } from "../src/engine/engine";
import { snapRange } from "../src/entries/grid";
import { ConfigError } from "../src/errors";
import type { CacheConfig, CalendarInterval } from "../src/types";

// Implementer tests added after pre-review 2 of step 129
// (docs/reviews/step-129.md, PR2-2).

// A default applies to an absent field only: null is a value, and no
// optional field of a config takes one (§2.2).
it.each([
  { field: "zone", interval: { unit: "day", zone: null } },
  { field: "at", interval: { unit: "day", at: null } },
  { field: "weekStart", interval: { unit: "week", weekStart: null } },
  { field: "weekStart", interval: { unit: "day", weekStart: null } },
])(
  "9: ConfigError names $field when it is null in $interval",
  ({ field, interval }) => {
    const named = new RegExp(`^(?:(?!\\bgot\\b).)*\\b${field}\\b`);
    const e = new Engine();
    const create = () =>
      e.cache({
        id: "c",
        interval,
        fields: { value: "f64" },
      } as unknown as CacheConfig);
    expect(create).toThrow(ConfigError);
    expect(create).toThrow(named);
    expect(e.has("c")).toBe(false);
    // The grid entry validates as cache() does.
    const snap = () =>
      snapRange({ start: 0, end: 1 }, interval as unknown as CalendarInterval);
    expect(snap).toThrow(ConfigError);
    expect(snap).toThrow(named);
  },
);

it("9: an absent optional field still takes its default", () => {
  const e = new Engine();
  const resolved = e.cache({
    id: "c",
    interval: { unit: "week", zone: undefined, at: undefined },
    fields: { value: "f64" },
  } as unknown as CacheConfig);
  expect(resolved.interval).toEqual({
    unit: "week",
    zone: "UTC",
    at: "00:00",
    weekStart: 1,
  });
});
