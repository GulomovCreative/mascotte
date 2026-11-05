import { approxEqual, EPSILON } from './common.ts';
import type { Quat } from './quat.ts';
import type { Vec3 } from './vec3.ts';

/**
 * Affine 3×4 matrix: a 3×3 linear part and a translation. Stored column-major:
 *
 * ```
 * | m[0] m[3] m[6] m[9]  |
 * | m[1] m[4] m[7] m[10] |
 * | m[2] m[5] m[8] m[11] |
 * ```
 *
 * The bottom row is implicitly `0 0 0 1`. Matrices are created only by `create`,
 * `clone` and `fromArray`, so they always have exactly 12 elements, and indexed reads
 * use `!` without an `undefined` check.
 */
export type Mat3x4 = Float64Array & { readonly [brand]: 'Mat3x4' };

declare const brand: unique symbol;

/*
 * All operations write the result to `out` and return it. `out` may be the same object
 * as any of the arguments.
 */

export function create(): Mat3x4 {
  return identity(new Float64Array(12) as Mat3x4);
}

export function clone(a: Readonly<Mat3x4>): Mat3x4 {
  return new Float64Array(a) as Mat3x4;
}

/** Matrix from 12 numbers in column-major order. Throws on any other length. */
export function fromArray(values: ArrayLike<number>): Mat3x4 {
  if (values.length !== 12) {
    throw new RangeError(`Mat3x4 requires 12 elements, got ${values.length}.`);
  }
  return Float64Array.from(values) as Mat3x4;
}

export function copy(out: Mat3x4, a: Readonly<Mat3x4>): Mat3x4 {
  out.set(a);
  return out;
}

export function identity(out: Mat3x4): Mat3x4 {
  out.fill(0);
  out[0] = 1;
  out[4] = 1;
  out[8] = 1;
  return out;
}

/** `out = a · b`: `b` is applied first, then `a`. */
export function multiply(out: Mat3x4, a: Readonly<Mat3x4>, b: Readonly<Mat3x4>): Mat3x4 {
  const a0 = a[0]!;
  const a1 = a[1]!;
  const a2 = a[2]!;
  const a3 = a[3]!;
  const a4 = a[4]!;
  const a5 = a[5]!;
  const a6 = a[6]!;
  const a7 = a[7]!;
  const a8 = a[8]!;
  const a9 = a[9]!;
  const a10 = a[10]!;
  const a11 = a[11]!;
  const b0 = b[0]!;
  const b1 = b[1]!;
  const b2 = b[2]!;
  const b3 = b[3]!;
  const b4 = b[4]!;
  const b5 = b[5]!;
  const b6 = b[6]!;
  const b7 = b[7]!;
  const b8 = b[8]!;
  const b9 = b[9]!;
  const b10 = b[10]!;
  const b11 = b[11]!;
  out[0] = a0 * b0 + a3 * b1 + a6 * b2;
  out[1] = a1 * b0 + a4 * b1 + a7 * b2;
  out[2] = a2 * b0 + a5 * b1 + a8 * b2;
  out[3] = a0 * b3 + a3 * b4 + a6 * b5;
  out[4] = a1 * b3 + a4 * b4 + a7 * b5;
  out[5] = a2 * b3 + a5 * b4 + a8 * b5;
  out[6] = a0 * b6 + a3 * b7 + a6 * b8;
  out[7] = a1 * b6 + a4 * b7 + a7 * b8;
  out[8] = a2 * b6 + a5 * b7 + a8 * b8;
  out[9] = a0 * b9 + a3 * b10 + a6 * b11 + a9;
  out[10] = a1 * b9 + a4 * b10 + a7 * b11 + a10;
  out[11] = a2 * b9 + a5 * b10 + a8 * b11 + a11;
  return out;
}

/** Rotation matrix from a unit quaternion. */
export function fromQuat(out: Mat3x4, q: Readonly<Quat>): Mat3x4 {
  return compose(out, ZERO, q, ONE);
}

const ZERO: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const ONE: Readonly<Vec3> = { x: 1, y: 1, z: 1 };

/**
 * Builds a matrix from translation, rotation and scale: `T(translation) · R · S`.
 * If `pivot` is given, rotation and scale happen about that point:
 * `T(translation) · T(pivot) · R · S · T(-pivot)`.
 */
export function compose(
  out: Mat3x4,
  translation: Readonly<Vec3>,
  rotation: Readonly<Quat>,
  scale: Readonly<Vec3>,
  pivot: Readonly<Vec3> = ZERO,
): Mat3x4 {
  const { x, y, z, w } = rotation;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = scale.x;
  const sy = scale.y;
  const sz = scale.z;

  const m0 = (1 - (yy + zz)) * sx;
  const m1 = (xy + wz) * sx;
  const m2 = (xz - wy) * sx;
  const m3 = (xy - wz) * sy;
  const m4 = (1 - (xx + zz)) * sy;
  const m5 = (yz + wx) * sy;
  const m6 = (xz + wy) * sz;
  const m7 = (yz - wx) * sz;
  const m8 = (1 - (xx + yy)) * sz;
  const { x: px, y: py, z: pz } = pivot;

  out[0] = m0;
  out[1] = m1;
  out[2] = m2;
  out[3] = m3;
  out[4] = m4;
  out[5] = m5;
  out[6] = m6;
  out[7] = m7;
  out[8] = m8;
  out[9] = translation.x + px - (m0 * px + m3 * py + m6 * pz);
  out[10] = translation.y + py - (m1 * px + m4 * py + m7 * pz);
  out[11] = translation.z + pz - (m2 * px + m5 * py + m8 * pz);
  return out;
}

export function determinant(m: Readonly<Mat3x4>): number {
  const m0 = m[0]!;
  const m1 = m[1]!;
  const m2 = m[2]!;
  const m3 = m[3]!;
  const m4 = m[4]!;
  const m5 = m[5]!;
  const m6 = m[6]!;
  const m7 = m[7]!;
  const m8 = m[8]!;
  return m0 * (m4 * m8 - m7 * m5) - m3 * (m1 * m8 - m7 * m2) + m6 * (m1 * m5 - m4 * m2);
}

/**
 * Inverse matrix. If the matrix is singular (for example, zero scale on one axis
 * or two parallel columns), returns `null` and leaves `out` unchanged. The threshold is
 * relative to the column lengths, so a very small but genuine scale is still inverted.
 */
export function invert(out: Mat3x4, m: Readonly<Mat3x4>): Mat3x4 | null {
  const m0 = m[0]!;
  const m1 = m[1]!;
  const m2 = m[2]!;
  const m3 = m[3]!;
  const m4 = m[4]!;
  const m5 = m[5]!;
  const m6 = m[6]!;
  const m7 = m[7]!;
  const m8 = m[8]!;
  const tx = m[9]!;
  const ty = m[10]!;
  const tz = m[11]!;
  const c0 = m4 * m8 - m7 * m5;
  const c1 = m7 * m2 - m1 * m8;
  const c2 = m1 * m5 - m4 * m2;
  const det = m0 * c0 + m3 * c1 + m6 * c2;
  // |det| is at most the product of the column lengths (Hadamard's inequality); their ratio
  // shows how close the matrix is to singular, independent of scale.
  const columns = Math.sqrt(
    (m0 * m0 + m1 * m1 + m2 * m2) * (m3 * m3 + m4 * m4 + m5 * m5) * (m6 * m6 + m7 * m7 + m8 * m8),
  );
  if (!(Math.abs(det) > 1e-12 * columns)) return null;
  const inv = 1 / det;
  const i0 = c0 * inv;
  const i1 = c1 * inv;
  const i2 = c2 * inv;
  const i3 = (m6 * m5 - m3 * m8) * inv;
  const i4 = (m0 * m8 - m6 * m2) * inv;
  const i5 = (m3 * m2 - m0 * m5) * inv;
  const i6 = (m3 * m7 - m6 * m4) * inv;
  const i7 = (m6 * m1 - m0 * m7) * inv;
  const i8 = (m0 * m4 - m3 * m1) * inv;
  out[0] = i0;
  out[1] = i1;
  out[2] = i2;
  out[3] = i3;
  out[4] = i4;
  out[5] = i5;
  out[6] = i6;
  out[7] = i7;
  out[8] = i8;
  out[9] = -(i0 * tx + i3 * ty + i6 * tz);
  out[10] = -(i1 * tx + i4 * ty + i7 * tz);
  out[11] = -(i2 * tx + i5 * ty + i8 * tz);
  return out;
}

/** Transforms a point: linear part and translation. */
export function transformPoint(out: Vec3, m: Readonly<Mat3x4>, v: Readonly<Vec3>): Vec3 {
  const { x, y, z } = v;
  out.x = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
  out.y = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
  out.z = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
  return out;
}

/** Transforms a direction: linear part only, no translation. */
export function transformDirection(out: Vec3, m: Readonly<Mat3x4>, v: Readonly<Vec3>): Vec3 {
  const { x, y, z } = v;
  out.x = m[0]! * x + m[3]! * y + m[6]! * z;
  out.y = m[1]! * x + m[4]! * y + m[7]! * z;
  out.z = m[2]! * x + m[5]! * y + m[8]! * z;
  return out;
}

export function getTranslation(out: Vec3, m: Readonly<Mat3x4>): Vec3 {
  out.x = m[9]!;
  out.y = m[10]!;
  out.z = m[11]!;
  return out;
}

export function equals(a: Readonly<Mat3x4>, b: Readonly<Mat3x4>, epsilon = EPSILON): boolean {
  for (let i = 0; i < 12; i++) {
    if (!approxEqual(a[i] ?? 0, b[i] ?? 0, epsilon)) return false;
  }
  return true;
}
