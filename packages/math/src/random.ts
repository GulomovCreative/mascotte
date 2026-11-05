/*
 * Deterministic randomness: values are pure functions of a seed and an index (or a position),
 * so an animation built on them gives the same frame at the same time, played or sought.
 */

/** Whether `seed` can be used: an integer from -2^31 to 2^32 - 1 (it is taken as 32 bits). */
export function isSeed(seed: number): boolean {
  return Number.isInteger(seed) && seed >= -0x80000000 && seed <= 0xffffffff;
}

/**
 * A pseudo-random number in `[0, 1)` for `seed` and integer `index`: the same arguments
 * always give the same number, and neighboring indices give unrelated ones. Both arguments
 * are taken as 32-bit integers.
 */
export function hash(seed: number, index: number): number {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(index | 0, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Smooth one-dimensional gradient noise at `x` for `seed`: continuous with a continuous
 * slope, in `[-0.5, 0.5]`, and 0 at every integer. One feature (a rise or a fall) per unit
 * on average.
 */
export function noise(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const g0 = hash(seed, i) * 2 - 1;
  const g1 = hash(seed, i + 1) * 2 - 1;
  const fade = f * f * f * (f * (f * 6 - 15) + 10);
  const a = g0 * f;
  return a + (g1 * (f - 1) - a) * fade;
}
