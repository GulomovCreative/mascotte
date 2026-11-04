import { approxEqual, clamp, EPSILON } from './common.ts';
import type { Euler, EulerOrder } from './euler.ts';
import type { Vec3 } from './vec3.ts';

/** Кватернион поворота `x·i + y·j + z·k + w`. Повороты считаются единичными кватернионами. */
export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/*
 * Все операции пишут результат в `out` и возвращают его. `out` может совпадать
 * с любым из аргументов. Положительный угол поворачивает по правилу правой руки:
 * вокруг Z от оси X к оси Y.
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

/** Поворот на `angle` радиан вокруг единичной оси `axis`. */
export function setAxisAngle(out: Quat, axis: Readonly<Vec3>, angle: number): Quat {
  const half = angle / 2;
  const s = Math.sin(half);
  return set(out, axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
}

/** `out = a · b`: сначала применяется поворот `b`, потом `a`. */
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

/** Нормирует кватернион. Нулевой кватернион становится единичным. */
export function normalize(out: Quat, a: Readonly<Quat>): Quat {
  const len = length(a);
  if (len === 0) return identity(out);
  const inv = 1 / len;
  return set(out, a.x * inv, a.y * inv, a.z * inv, a.w * inv);
}

/** Сопряжённый кватернион. Для единичного кватерниона это обратный поворот. */
export function conjugate(out: Quat, a: Readonly<Quat>): Quat {
  return set(out, -a.x, -a.y, -a.z, a.w);
}

/** Обратный кватернион, в том числе для неединичного. */
export function invert(out: Quat, a: Readonly<Quat>): Quat {
  const lenSq = dot(a, a);
  if (lenSq === 0) return identity(out);
  const inv = 1 / lenSq;
  return set(out, -a.x * inv, -a.y * inv, -a.z * inv, a.w * inv);
}

/** Сферическая интерполяция по кратчайшему пути. */
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
    // Почти совпадающие повороты: линейная интерполяция с нормировкой точнее и дешевле.
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

/** Поворачивает вектор `v` единичным кватернионом `q`. */
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

/** Задают ли кватернионы один и тот же поворот (`q` и `-q` считаются равными). */
export function equalsRotation(a: Readonly<Quat>, b: Readonly<Quat>, epsilon = EPSILON): boolean {
  return approxEqual(Math.abs(dot(a, b)), 1, epsilon);
}

export function equals(a: Readonly<Quat>, b: Readonly<Quat>, epsilon = EPSILON): boolean {
  return (
    approxEqual(a.x, b.x, epsilon) &&
    approxEqual(a.y, b.y, epsilon) &&
    approxEqual(a.z, b.z, epsilon) &&
    approxEqual(a.w, b.w, epsilon)
  );
}

// ----- углы Эйлера ----- //

/** Поворот из углов Эйлера. Порядок осей описан в `EulerOrder`. */
export function fromEuler(out: Quat, euler: Readonly<Euler>): Quat {
  const { x, y, z, order } = euler;
  identity(out);
  // Матрица `Ra · Rb · Rc` для порядка 'ABC': умножаем справа в порядке записи.
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
 * Углы Эйлера для единичного кватерниона в заданном порядке. Средний угол лежит
 * в диапазоне [-π/2, π/2], крайние в [-π, π]. В блокировке осей (средний угол ±π/2)
 * третий угол обнуляется.
 */
export function toEuler(out: Euler, q: Readonly<Quat>, order: EulerOrder = out.order): Euler {
  const { x, y, z, w } = q;
  // Элементы матрицы поворота, mRC — строка R, столбец C.
  const m11 = 1 - 2 * (y * y + z * z);
  const m12 = 2 * (x * y - w * z);
  const m13 = 2 * (x * z + w * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m31 = 2 * (x * z - w * y);
  const m32 = 2 * (y * z + w * x);
  const m33 = 1 - 2 * (x * x + y * y);
  const limit = 1 - 1e-7;
  let ex = 0;
  let ey = 0;
  let ez = 0;

  switch (order) {
    case 'XYZ':
      ey = Math.asin(clamp(m13, -1, 1));
      if (Math.abs(m13) < limit) {
        ex = Math.atan2(-m23, m33);
        ez = Math.atan2(-m12, m11);
      } else {
        ex = Math.atan2(m32, m22);
      }
      break;
    case 'XZY':
      ez = Math.asin(-clamp(m12, -1, 1));
      if (Math.abs(m12) < limit) {
        ex = Math.atan2(m32, m22);
        ey = Math.atan2(m13, m11);
      } else {
        ex = Math.atan2(-m23, m33);
      }
      break;
    case 'YXZ':
      ex = Math.asin(-clamp(m23, -1, 1));
      if (Math.abs(m23) < limit) {
        ey = Math.atan2(m13, m33);
        ez = Math.atan2(m21, m22);
      } else {
        ey = Math.atan2(-m31, m11);
      }
      break;
    case 'YZX':
      ez = Math.asin(clamp(m21, -1, 1));
      if (Math.abs(m21) < limit) {
        ex = Math.atan2(-m23, m22);
        ey = Math.atan2(-m31, m11);
      } else {
        ey = Math.atan2(m13, m33);
      }
      break;
    case 'ZXY':
      ex = Math.asin(clamp(m32, -1, 1));
      if (Math.abs(m32) < limit) {
        ey = Math.atan2(-m31, m33);
        ez = Math.atan2(-m12, m22);
      } else {
        ez = Math.atan2(m21, m11);
      }
      break;
    case 'ZYX':
      ey = Math.asin(-clamp(m31, -1, 1));
      if (Math.abs(m31) < limit) {
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
