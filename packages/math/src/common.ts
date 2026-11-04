/** Полный оборот в радианах. */
export const TAU = Math.PI * 2;

/** Допуск по умолчанию для приближённых сравнений. */
export const EPSILON = 1e-6;

/** Равны ли числа с точностью до `epsilon` (абсолютной для малых и относительной для больших). */
export function approxEqual(a: number, b: number, epsilon = EPSILON): boolean {
  return Math.abs(a - b) <= epsilon * Math.max(1, Math.abs(a), Math.abs(b));
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
