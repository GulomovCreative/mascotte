import { approxEqual, EPSILON } from './common.ts';
import type { Euler, EulerOrder } from './euler.ts';
import type { Vec3 } from './vec3.ts';

/** Rotation quaternion `x·i + y·j + z·k + w`. Rotations are represented by unit quaternions. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/*
 * All operations write the result to `out` and return it. `out` may be the same object
 * as any of the arguments. A positive angle rotates by the right-hand rule:
 * about Z from the X axis towards the Y axis.
 */

export function create(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function clone(a: Readonly<Quat>): Quat {
  return { x: a.x, y: a.y, z: a.z, w: a.w };
}

export function set(out: Quat, x: number, y: number, z: number, w: number): Quat {
  out.x = x;
  out.y = y;
  out.z = z;
  out.w = w;
  return out;
}

export function copy(out: Quat, a: Readonly<Quat>): Quat {
  return set(out, a.x, a.y, a.z, a.w);
}

export function identity(out: Quat): Quat {
  return set(out, 0, 0, 0, 1);
}

/** Rotation by `angle` radians about the unit axis `axis`. */
export function setAxisAngle(out: Quat, axis: Readonly<Vec3>, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return set(out, axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
}

/** `out = a · b`: rotation `b` is applied first, then `a`. */
export function multiply(out: Quat, a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const { x: ax, y: ay, z: az, w: aw } = a;
  const { x: bx, y: by, z: bz, w: bw } = b;
  return set(
    out,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  );
}

export function dot(a: Readonly<Quat>, b: Readonly<Quat>): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

export function length(a: Readonly<Quat>): number {
  return Math.sqrt(dot(a, a));
}

/** Normalizes a quaternion. A zero quaternion becomes the identity. */
export function normalize(out: Quat, a: Readonly<Quat>): Quat {
  const len = length(a);
  if (len === 0) return identity(out);
  const inv = 1 / len;
  return set(out, a.x * inv, a.y * inv, a.z * inv, a.w * inv);
}

/** Conjugate quaternion. For a unit quaternion this is the inverse rotation. */
export function conjugate(out: Quat, a: Readonly<Quat>): Quat {
  return set(out, -a.x, -a.y, -a.z, a.w);
}

/** Inverse quaternion, including non-unit ones. A zero quaternion becomes the identity. */
export function invert(out: Quat, a: Readonly<Quat>): Quat {
  const lenSq = dot(a, a);
  if (lenSq === 0) return identity(out);
  const inv = 1 / lenSq;
  return set(out, -a.x * inv, -a.y * inv, -a.z * inv, a.w * inv);
}

/** Spherical interpolation along the shortest path. */
export function slerp(out: Quat, a: Readonly<Quat>, b: Readonly<Quat>, t: number): Quat {
  let { x: bx, y: by, z: bz, w: bw } = b;
  let cos = dot(a, b);
  if (cos < 0) {
    cos = -cos;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (cos > 1 - EPSILON) {
    // Nearly identical rotations: normalized linear interpolation is more accurate and cheaper.
    wa = 1 - t;
    wb = t;
  } else {
    const angle = Math.acos(cos);
    const sin = Math.sin(angle);
    wa = Math.sin((1 - t) * angle) / sin;
    wb = Math.sin(t * angle) / sin;
  }
  set(out, wa * a.x + wb * bx, wa * a.y + wb * by, wa * a.z + wb * bz, wa * a.w + wb * bw);
  return normalize(out, out);
}

/**
 * The shortest rotation that turns the direction of `from` into the direction of `to` (the
 * vectors need not be unit). Opposite directions turn by π about an axis perpendicular to
 * `from`; a zero vector gives the identity.
 */
export function rotationTo(out: Quat, from: Readonly<Vec3>, to: Readonly<Vec3>): Quat {
  const lengths = Math.sqrt(
    (from.x * from.x + from.y * from.y + from.z * from.z) *
      (to.x * to.x + to.y * to.y + to.z * to.z),
  );
  if (!(lengths > 0)) return identity(out);
  const w = lengths + from.x * to.x + from.y * to.y + from.z * to.z;
  if (w <= lengths * 1e-12) {
    // Opposite: any axis perpendicular to `from`, here from crossing it with the axis it is
    // least aligned with.
    const ax = Math.abs(from.x);
    const ay = Math.abs(from.y);
    const az = Math.abs(from.z);
    if (ax <= ay && ax <= az) set(out, 0, -from.z, from.y, 0);
    else if (ay <= az) set(out, from.z, 0, -from.x, 0);
    else set(out, -from.y, from.x, 0, 0);
    return normalize(out, out);
  }
  // With θ the angle between them, (from × to, |from||to| + from · to) is |from||to| times
  // (sin θ · axis, 1 + cos θ), which normalizes to (sin(θ/2) · axis, cos(θ/2)).
  set(
    out,
    from.y * to.z - from.z * to.y,
    from.z * to.x - from.x * to.z,
    from.x * to.y - from.y * to.x,
    w,
  );
  return normalize(out, out);
}

/** Rotates vector `v` by unit quaternion `q`. */
export function transformVec3(out: Vec3, q: Readonly<Quat>, v: Readonly<Vec3>): Vec3 {
  const { x: qx, y: qy, z: qz, w: qw } = q;
  const { x, y, z } = v;
  // v' = v + 2w(q × v) + 2q × (q × v)
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/**
 * Angle in radians between the rotations of unit quaternions `a` and `b`, from 0 to π.
 * Accurate for very close rotations too.
 */
export function angleBetween(a: Readonly<Quat>, b: Readonly<Quat>): number {
  // |a − b| = 2·sin(θ/4) after choosing the sign of b closer to a; asin is accurate for small angles.
  const sign = dot(a, b) < 0 ? -1 : 1;
  const dx = a.x - sign * b.x;
  const dy = a.y - sign * b.y;
  const dz = a.z - sign * b.z;
  const dw = a.w - sign * b.w;
  const half = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw) / 2;
  return 4 * Math.asin(Math.min(1, half));
}

/**
 * Whether unit quaternions represent the same rotation within an angle of `epsilon`
 * radians (`q` and `-q` are considered equal).
 */
export function equalsRotation(a: Readonly<Quat>, b: Readonly<Quat>, epsilon = EPSILON): boolean {
  return angleBetween(a, b) <= epsilon;
}

export function equals(a: Readonly<Quat>, b: Readonly<Quat>, epsilon = EPSILON): boolean {
  return (
    approxEqual(a.x, b.x, epsilon) &&
    approxEqual(a.y, b.y, epsilon) &&
    approxEqual(a.z, b.z, epsilon) &&
    approxEqual(a.w, b.w, epsilon)
  );
}

// ----- Euler angles ----- //

/** Rotation from Euler angles. Axis order is described in `EulerOrder`. */
export function fromEuler(out: Quat, euler: Readonly<Euler>): Quat {
  const { x, y, z, order } = euler;
  identity(out);
  // Matrix `Ra · Rb · Rc` for order 'ABC': multiply on the right in the written order.
  for (let i = 0; i < 3; i++) {
    const axis = order[i];
    const angle = axis === 'X' ? x : axis === 'Y' ? y : z;
    if (angle === 0) continue;
    const s = Math.sin(angle / 2);
    const c = Math.cos(angle / 2);
    const { x: ox, y: oy, z: oz, w: ow } = out;
    if (axis === 'X') set(out, ow * s + ox * c, oy * c + oz * s, oz * c - oy * s, ow * c - ox * s);
    else if (axis === 'Y')
      set(out, ox * c - oz * s, ow * s + oy * c, oz * c + ox * s, ow * c - oy * s);
    else set(out, ox * c + oy * s, oy * c - ox * s, ow * s + oz * c, ow * c - oz * s);
  }
  return out;
}

/**
 * Euler angles of a unit quaternion in the given order (default `out.order`).
 * The middle angle lies in [-π/2, π/2], the outer ones in [-π, π]. In gimbal lock
 * (middle angle ±π/2) the last angle in the order is set to zero and the whole rotation
 * moves to the first one.
 */
export function toEuler(out: Euler, q: Readonly<Quat>, order: EulerOrder = out.order): Euler {
  const { x, y, z, w } = q;
  // Rotation matrix elements, mRC is row R, column C.
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m31 = 2 * (x * z - w * y);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  let ex = 0;
  let ey = 0;
  let ez = 0;
  // The middle angle uses atan2, not asin: asin loses precision near ±π/2.
  // Gimbal lock applies only when the cosine of the middle angle is indistinguishable from zero.
  const lock = 1e-9;
  let cos: number;

  switch (order) {
    case 'XYZ':
      cos = Math.sqrt(m11 * m11 + m12 * m12);
      ey = Math.atan2(m13, cos);
      if (cos > lock) {
        ex = Math.atan2(-m23, m33);
        ez = Math.atan2(-m12, m11);
      } else {
        ex = Math.atan2(m32, m22);
      }
      break;
    case 'XZY':
      cos = Math.sqrt(m11 * m11 + m13 * m13);
      ez = Math.atan2(-m12, cos);
      if (cos > lock) {
        ex = Math.atan2(m32, m22);
        ey = Math.atan2(m13, m11);
      } else {
        ex = Math.atan2(-m23, m33);
      }
      break;
    case 'YXZ':
      cos = Math.sqrt(m21 * m21 + m22 * m22);
      ex = Math.atan2(-m23, cos);
      if (cos > lock) {
        ey = Math.atan2(m13, m33);
        ez = Math.atan2(m21, m22);
      } else {
        ey = Math.atan2(-m31, m11);
      }
      break;
    case 'YZX':
      cos = Math.sqrt(m11 * m11 + m31 * m31);
      ez = Math.atan2(m21, cos);
      if (cos > lock) {
        ex = Math.atan2(-m23, m22);
        ey = Math.atan2(-m31, m11);
      } else {
        ey = Math.atan2(m13, m33);
      }
      break;
    case 'ZXY':
      cos = Math.sqrt(m31 * m31 + m33 * m33);
      ex = Math.atan2(m32, cos);
      if (cos > lock) {
        ey = Math.atan2(-m31, m33);
        ez = Math.atan2(-m12, m22);
      } else {
        ez = Math.atan2(m21, m11);
      }
      break;
    case 'ZYX':
      cos = Math.sqrt(m32 * m32 + m33 * m33);
      ey = Math.atan2(-m31, cos);
      if (cos > lock) {
        ex = Math.atan2(m32, m33);
        ez = Math.atan2(m21, m11);
      } else {
        ez = Math.atan2(-m12, m22);
      }
      break;
  }
  out.x = ex;
  out.y = ey;
  out.z = ez;
  out.order = order;
  return out;
}
