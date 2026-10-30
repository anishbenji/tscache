import type { SlotRange } from "../src/grid";

/** Independent, finite slot-set oracle for §4.9.1 rules 2–3. */
export function roundModel(
  request: SlotRange,
  around: readonly SlotRange[],
  inflight: readonly SlotRange[],
  blocked: readonly SlotRange[],
): { fetch: SlotRange[]; join: number[] } {
  const slots = (ranges: readonly SlotRange[]) => {
    const set = new Set<number>();
    for (const r of ranges) for (let s = r.start; s <= r.end; s++) set.add(s);
    return set;
  };
  const covered = slots(around);
  const busy = slots(inflight);
  const excluded = slots(blocked);
  const need = new Set<number>();
  const fetched = new Set<number>();
  for (let s = request.start; s <= request.end; s++) {
    if (!covered.has(s) && !excluded.has(s)) {
      need.add(s);
      if (!busy.has(s)) {
        fetched.add(s);
        if (covered.has(s - 1)) fetched.add(s - 1);
        if (covered.has(s + 1)) fetched.add(s + 1);
      }
    }
  }
  const fetch: SlotRange[] = [];
  for (const s of [...fetched].sort((a, b) => a - b)) {
    const last = fetch.at(-1);
    if (last && last.end + 1 === s) last.end = s;
    else fetch.push({ start: s, end: s });
  }
  const join = inflight.flatMap((r, i) => {
    for (let s = r.start; s <= r.end; s++) if (need.has(s)) return [i];
    return [];
  });
  return { fetch, join };
}
