import { expect } from 'vitest';

/** Deterministic pseudo-random number generator (mulberry32). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random number in the range [min, max). */
export function range(next: () => number, min: number, max: number): number {
  return min + (max - min) * next();
}

/**
 * Checks that the objects have the same set of fields and that numeric fields match
 * to `digits` decimal places.
 */
export function expectClose<T extends object>(actual: T, expected: T, digits = 9): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const key of Object.keys(expected) as (keyof T)[]) {
    const value = expected[key];
    if (typeof value === 'number') {
      expect(actual[key], String(key)).toBeCloseTo(value, digits);
    } else {
      expect(actual[key], String(key)).toEqual(value);
    }
  }
}
