import { approxEqual, EPSILON } from './common.ts';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/*
 * All operations write the result to `out` and return it. `out` may be the same object
 * as any of the arguments. Transforms by a matrix and a quaternion live in the modules
 * `mat3x4` and `quat`.
 */

export function create(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clone(a: Readonly<Vec3>): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vec3, a: Readonly<Vec3>): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function add(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function sub(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

/** Component-wise product. */
export function mul(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  out.x = a.x * b.x;
  out.y = a.y * b.y;
  out.z = a.z * b.z;
  return out;
}

export function scale(out: Vec3, a: Readonly<Vec3>, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

/** `out = a + b * s`. */
export function scaleAndAdd(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function negate(out: Vec3, a: Readonly<Vec3>): Vec3 {
  out.x = -a.x;
  out.y = -a.y;
  out.z = -a.z;
  return out;
}

export function dot(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>): Vec3 {
  const { x: ax, y: ay, z: az } = a;
  const { x: bx, y: by, z: bz } = b;
  out.x = ay * bz - az * by;
  out.y = az * bx - ax * bz;
  out.z = ax * by - ay * bx;
  return out;
}

export function lengthSq(a: Readonly<Vec3>): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Readonly<Vec3>): number {
  return Math.sqrt(lengthSq(a));
}

export function distanceSq(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function distance(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  return Math.sqrt(distanceSq(a, b));
}

/** Normalizes a vector. A zero vector stays zero. */
export function normalize(out: Vec3, a: Readonly<Vec3>): Vec3 {
  const len = length(a);
  return scale(out, a, len > 0 ? 1 / len : 0);
}

export function lerp(out: Vec3, a: Readonly<Vec3>, b: Readonly<Vec3>, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function equals(a: Readonly<Vec3>, b: Readonly<Vec3>, epsilon = EPSILON): boolean {
  return (
    approxEqual(a.x, b.x, epsilon) &&
    approxEqual(a.y, b.y, epsilon) &&
    approxEqual(a.z, b.z, epsilon)
  );
}
