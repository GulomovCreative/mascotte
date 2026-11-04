import { approxEqual, EPSILON } from './common.ts';

export interface Vec2 {
  x: number;
  y: number;
}

/*
 * Все операции пишут результат в `out` и возвращают его. `out` может совпадать
 * с любым из аргументов.
 */

export function create(x = 0, y = 0): Vec2 {
  return { x, y };
}

export function clone(a: Readonly<Vec2>): Vec2 {
  return { x: a.x, y: a.y };
}

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, a: Readonly<Vec2>): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function add(out: Vec2, a: Readonly<Vec2>, b: Readonly<Vec2>): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function sub(out: Vec2, a: Readonly<Vec2>, b: Readonly<Vec2>): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function scale(out: Vec2, a: Readonly<Vec2>, s: number): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

/** `out = a + b * s`. */
export function scaleAndAdd(out: Vec2, a: Readonly<Vec2>, b: Readonly<Vec2>, s: number): Vec2 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  return out;
}

export function negate(out: Vec2, a: Readonly<Vec2>): Vec2 {
  out.x = -a.x;
  out.y = -a.y;
  return out;
}

export function dot(a: Readonly<Vec2>, b: Readonly<Vec2>): number {
  return a.x * b.x + a.y * b.y;
}

/** Z-компонента векторного произведения: положительна, если `b` повёрнут от `a` к оси Y. */
export function cross(a: Readonly<Vec2>, b: Readonly<Vec2>): number {
  return a.x * b.y - a.y * b.x;
}

export function lengthSq(a: Readonly<Vec2>): number {
  return a.x * a.x + a.y * a.y;
}

export function length(a: Readonly<Vec2>): number {
  return Math.hypot(a.x, a.y);
}

export function distance(a: Readonly<Vec2>, b: Readonly<Vec2>): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Нормирует вектор. Нулевой вектор остаётся нулевым. */
export function normalize(out: Vec2, a: Readonly<Vec2>): Vec2 {
  const len = length(a);
  const inv = len > 0 ? 1 / len : 0;
  out.x = a.x * inv;
  out.y = a.y * inv;
  return out;
}

export function lerp(out: Vec2, a: Readonly<Vec2>, b: Readonly<Vec2>, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

/** Поворот на `angle` радиан от оси X к оси Y. */
export function rotate(out: Vec2, a: Readonly<Vec2>, angle: number): Vec2 {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const { x, y } = a;
  out.x = x * cos - y * sin;
  out.y = x * sin + y * cos;
  return out;
}

export function equals(a: Readonly<Vec2>, b: Readonly<Vec2>, epsilon = EPSILON): boolean {
  return approxEqual(a.x, b.x, epsilon) && approxEqual(a.y, b.y, epsilon);
}
