import { approxEqual, EPSILON } from './common.ts';
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

/** Обратный кватернион, в том числе для неединичного. Нулевой кватернион становится единичным. */
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

/**
 * Угол в радианах между поворотами единичных кватернионов `a` и `b`, от 0 до π.
 * Точен и для очень близких поворотов.
 */
export function angleBetween(a: Readonly<Quat>, b: Readonly<Quat>): number {
  // |a − b| = 2·sin(θ/4) после выбора знака b ближе к a; asin точен для малых углов.
  const sign = dot(a, b) < 0 ? -1 : 1;
  const dx = a.x - sign * b.x;
  const dy = a.y - sign * b.y;
  const dz = a.z - sign * b.z;
  const dw = a.w - sign * b.w;
  const half = Math.sqrt(dx * dx + dy * dy + dz * dz + dw * dw) / 2;
  return 4 * Math.asin(Math.min(1, half));
}

/**
 * Задают ли единичные кватернионы один и тот же поворот с точностью до угла `epsilon`
 * радиан (`q` и `-q` считаются равными).
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
 * Углы Эйлера для единичного кватерниона в заданном порядке (по умолчанию `out.order`).
 * Средний угол лежит в диапазоне [-π/2, π/2], крайние в [-π, π]. В блокировке осей
 * (средний угол ±π/2) последний по порядку угол обнуляется, а поворот целиком
 * переносится на первый.
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
  let ex = 0;
  let ey = 0;
  let ez = 0;
  // Средний угол считается через atan2, а не asin: asin теряет точность около ±π/2.
  // Блокировка осей наступает, только когда косинус среднего угла неотличим от нуля.
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
