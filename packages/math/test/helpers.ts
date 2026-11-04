import { expect } from 'vitest';

/** Детерминированный генератор псевдослучайных чисел (mulberry32). */
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

/** Случайное число из диапазона [min, max). */
export function range(next: () => number, min: number, max: number): number {
  return min + (max - min) * next();
}

/** Проверяет, что поля объекта совпадают с ожидаемыми с точностью до `digits` знаков. */
export function expectClose<T extends object>(actual: T, expected: T, digits = 9): void {
  for (const key of Object.keys(expected) as (keyof T)[]) {
    const value = expected[key];
    if (typeof value === 'number') {
      expect(actual[key], String(key)).toBeCloseTo(value, digits);
    } else {
      expect(actual[key], String(key)).toEqual(value);
    }
  }
}
