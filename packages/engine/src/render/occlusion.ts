import { ScreenOp, type ScreenPath } from './screen-path.ts';

/*
 * Частичное перекрытие: обводка, которая проходит за перекрывателем, режется на часть
 * за ним (рисуется до перекрывателя) и часть перед ним (рисуется после).
 *
 * - Сфера режет своей передней поверхностью: точка скрыта, если на экране она внутри
 *   силуэта и глубже передней поверхности. Это точно и для фигур, которые входят внутрь
 *   сферы, — например, уха, растущего из головы.
 * - Капсула режет плоскостью, перпендикулярной взгляду, через середину оси. При наклоне
 *   капсулы к взгляду это приближение.
 *
 * Координаты пути экранные (пиксели), глубина — в единицах пространства камеры.
 */

/** Чем режется путь. */
export interface Cutter {
  kind: 'sphere' | 'plane';
  /** Центр сферы на экране, пиксели. */
  x: number;
  y: number;
  /** Глубина центра сферы или плоскости. */
  depth: number;
  /** Радиус силуэта сферы, пиксели. */
  radius: number;
  /** Пикселей на единицу глубины в центре сферы: чтобы сравнивать экранное и глубину. */
  scale: number;
}

/**
 * Знак: отрицательное значение — точка за перекрывателем, неотрицательное — перед ним.
 */
export function cutValue(cutter: Readonly<Cutter>, x: number, y: number, z: number): number {
  if (cutter.kind === 'plane') return z - cutter.depth;
  const dx = (x - cutter.x) / cutter.scale;
  const dy = (y - cutter.y) / cutter.scale;
  const r = cutter.radius / cutter.scale;
  const inside = r * r - dx * dx - dy * dy;
  // Вне силуэта сфера ничего не закрывает.
  if (inside <= 0) return 1;
  return z - (cutter.depth + Math.sqrt(inside));
}

/** Куда пишутся части: `[за перекрывателем, перед ним]`. */
export type SplitTarget = readonly [ScreenPath, ScreenPath];

type Side = 0 | 1;

const pen = { x: 0, y: 0, z: 0, continuing: [false, false] as [boolean, boolean] };

function sideOf(value: number): Side {
  return value < 0 ? 0 : 1;
}

/** Начинает кусок стороны `side` в текущей точке пера, если эта сторона не продолжается из неё. */
function start(target: SplitTarget, side: Side): ScreenPath {
  const path = target[side];
  if (!pen.continuing[side]) {
    path.moveTo(pen.x, pen.y, pen.z);
    pen.continuing[side] = true;
  }
  pen.continuing[side === 0 ? 1 : 0] = false;
  return path;
}

function bezier(a: number, b: number, c: number, d: number, t: number): number {
  const u = 1 - t;
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
}

// Отрезок или кривая, которые сейчас режутся: точки по t.
const seg = {
  cubic: false,
  x: [0, 0, 0, 0],
  y: [0, 0, 0, 0],
  z: [0, 0, 0, 0],
};

function at(t: number, axis: number[]): number {
  if (seg.cubic) {
    return bezier(axis[0] as number, axis[1] as number, axis[2] as number, axis[3] as number, t);
  }
  return (axis[0] as number) + ((axis[3] as number) - (axis[0] as number)) * t;
}

function valueAt(cutter: Readonly<Cutter>, t: number): number {
  return cutValue(cutter, at(t, seg.x), at(t, seg.y), at(t, seg.z));
}

/** Не больше этого числа смен стороны на одном куске. */
const MAX_ROOTS = 8;
const roots = new Float64Array(MAX_ROOTS);
const SAMPLES = 24;

/** Значения `t` на (0, 1), где кусок пересекает поверхность разреза. */
function crossings(cutter: Readonly<Cutter>): number {
  let count = 0;
  let prevT = 0;
  let prev = valueAt(cutter, 0) < 0;
  for (let i = 1; i <= SAMPLES && count < MAX_ROOTS; i++) {
    const t = i / SAMPLES;
    const behind = valueAt(cutter, t) < 0;
    if (behind !== prev) {
      let lo = prevT;
      let hi = t;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (valueAt(cutter, mid) < 0 === prev) lo = mid;
        else hi = mid;
      }
      roots[count++] = (lo + hi) / 2;
    }
    prevT = t;
    prev = behind;
  }
  return count;
}

const part = [0, 0, 0, 0];

/** Опорные точки куска кривой на [t0, t1] по одной координате (де Кастельжо). */
function subCurve(axis: number[], t0: number, t1: number): void {
  let p0 = axis[0] as number;
  let p1 = axis[1] as number;
  let p2 = axis[2] as number;
  let p3 = axis[3] as number;
  if (t0 > 0) {
    const ab = p0 + (p1 - p0) * t0;
    const bc = p1 + (p2 - p1) * t0;
    const cd = p2 + (p3 - p2) * t0;
    const abc = ab + (bc - ab) * t0;
    const bcd = bc + (cd - bc) * t0;
    p0 = abc + (bcd - abc) * t0;
    p1 = bcd;
    p2 = cd;
  }
  const s = t0 < 1 ? (t1 - t0) / (1 - t0) : 1;
  if (s < 1) {
    const ab = p0 + (p1 - p0) * s;
    const bc = p1 + (p2 - p1) * s;
    const cd = p2 + (p3 - p2) * s;
    const abc = ab + (bc - ab) * s;
    const bcd = bc + (cd - bc) * s;
    p1 = ab;
    p2 = abc;
    p3 = abc + (bcd - abc) * s;
  }
  part[0] = p0;
  part[1] = p1;
  part[2] = p2;
  part[3] = p3;
}

/** Режет текущий кусок (`seg`, начало — в пере) и дописывает части в `target`. */
function cutSegment(cutter: Readonly<Cutter>, target: SplitTarget): void {
  const count = crossings(cutter);
  let t0 = 0;
  for (let i = 0; i <= count; i++) {
    const t1 = i < count ? (roots[i] as number) : 1;
    const side = sideOf(valueAt(cutter, (t0 + t1) / 2));
    const path = start(target, side);
    if (seg.cubic) {
      subCurve(seg.x, t0, t1);
      const ax = part[1] as number;
      const bx = part[2] as number;
      const ex = part[3] as number;
      subCurve(seg.y, t0, t1);
      const ay = part[1] as number;
      const by = part[2] as number;
      const ey = part[3] as number;
      subCurve(seg.z, t0, t1);
      path.cubicTo(ax, ay, bx, by, ex, ey, part[1] as number, part[2] as number, part[3] as number);
      pen.x = ex;
      pen.y = ey;
      pen.z = part[3] as number;
    } else {
      pen.x = at(t1, seg.x);
      pen.y = at(t1, seg.y);
      pen.z = at(t1, seg.z);
      path.lineTo(pen.x, pen.y, pen.z);
    }
    // На границе кусков другая сторона продолжит с этой же точки.
    if (i < count) pen.continuing[side] = false;
    t0 = t1;
  }
}

function setLine(x: number, y: number, z: number): void {
  seg.cubic = false;
  seg.x[0] = pen.x;
  seg.y[0] = pen.y;
  seg.z[0] = pen.z;
  seg.x[3] = x;
  seg.y[3] = y;
  seg.z[3] = z;
}

/**
 * Режет путь с глубинами поверхностью `cutter` и дописывает части в `target`: `[0]` —
 * за перекрывателем, `[1]` — перед ним. Части не замкнуты: замыкающий отрезок
 * замкнутого пути режется так же, как остальные. Дуги пропускаются: у разрезаемых
 * обводок их нет.
 */
export function splitPath(path: ScreenPath, cutter: Readonly<Cutter>, target: SplitTarget): void {
  const { ops, data, depths, opCount } = path;
  let d = 0;
  let p = 0;
  let startX = 0;
  let startY = 0;
  let startZ = 0;
  pen.continuing[0] = false;
  pen.continuing[1] = false;
  for (let op = 0; op < opCount; op++) {
    switch (ops[op]) {
      case ScreenOp.move:
        pen.x = data[d] ?? 0;
        pen.y = data[d + 1] ?? 0;
        pen.z = depths[p] ?? 0;
        startX = pen.x;
        startY = pen.y;
        startZ = pen.z;
        pen.continuing[0] = false;
        pen.continuing[1] = false;
        d += 2;
        p += 1;
        break;
      case ScreenOp.line:
        setLine(data[d] ?? 0, data[d + 1] ?? 0, depths[p] ?? 0);
        cutSegment(cutter, target);
        d += 2;
        p += 1;
        break;
      case ScreenOp.cubic:
        seg.cubic = true;
        seg.x[0] = pen.x;
        seg.y[0] = pen.y;
        seg.z[0] = pen.z;
        for (let k = 0; k < 3; k++) {
          seg.x[k + 1] = data[d + k * 2] ?? 0;
          seg.y[k + 1] = data[d + k * 2 + 1] ?? 0;
          seg.z[k + 1] = depths[p + k] ?? 0;
        }
        cutSegment(cutter, target);
        d += 6;
        p += 3;
        break;
      case ScreenOp.arc:
        d += 6;
        break;
    }
  }
  if (path.closed) {
    setLine(startX, startY, startZ);
    cutSegment(cutter, target);
  }
}
