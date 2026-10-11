// Stateless pseudo-random values. A value depends only on its seed and its
// key (a timestamp, or a timestamp divided by a time scale), never on which
// request asked for it, so every range the backend serves agrees with every
// other: history never changes unless the dataset version does.

const TWO_32 = 4_294_967_296;

/** 32-bit FNV-1a hash of a string: the seed of a series. */
export function seedOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Uniform in [0, 1) for an integer key; keys may exceed 2^32 (timestamps). */
export function unit(seed: number, key: number): number {
  const lo = key >>> 0;
  const hi = Math.floor(key / TWO_32) >>> 0;
  let h =
    Math.imul(seed ^ lo, 0x85ebca6b) ^ Math.imul(hi + 0x9e3779b9, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / TWO_32;
}

/** Smooth noise in [-1, 1]: random values at integers, eased in between. */
function smooth(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const eased = f * f * (3 - 2 * f);
  const a = unit(seed, i);
  return (a + (unit(seed, i + 1) - a) * eased) * 2 - 1;
}

/** Sum of smooth noise at several time scales (ms), each with its weight. */
export function wander(
  seed: number,
  t: number,
  octaves: ReadonlyArray<readonly [scaleMs: number, weight: number]>,
): number {
  let sum = 0;
  for (const [k, [scale, weight]] of octaves.entries()) {
    sum += weight * smooth(seed + k, t / scale);
  }
  return sum;
}
