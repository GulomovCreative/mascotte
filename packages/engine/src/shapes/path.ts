import type { Vec3 } from '@mascotte/math';

/** Точка пути. Пропущенные координаты равны 0. */
export type PathPoint = Readonly<Partial<Vec3>>;

/**
 * Команда пути в локальных координатах фигуры.
 * - `move` — начать новый контур;
 * - `line` — отрезок до точки;
 * - `bezier` — кубическая кривая Безье;
 * - `arc` — четверть дуги: из текущей точки к `point` через угол `corner`, как в Zdog.
 */
export type PathCommand =
  | { readonly type: 'move'; readonly point: PathPoint }
  | { readonly type: 'line'; readonly point: PathPoint }
  | {
      readonly type: 'bezier';
      readonly control1: PathPoint;
      readonly control2: PathPoint;
      readonly point: PathPoint;
    }
  | { readonly type: 'arc'; readonly corner: PathPoint; readonly point: PathPoint };

/** Код операции в собранной геометрии. */
export const PathOp = {
  /** Одна точка. */
  move: 0,
  /** Одна точка. */
  line: 1,
  /** Три точки: две опорные и конечная. */
  cubic: 2,
} as const;
export type PathOp = (typeof PathOp)[keyof typeof PathOp];

/**
 * Длина ручек кривой Безье, заменяющей четверть дуги, в долях от расстояния до угла.
 * Значение из Zdog: так дуга выглядит круглой при толстой обводке.
 */
export const ARC_HANDLE = 9 / 16;

/**
 * Собранная геометрия пути: только `move`, `line` и кубические кривые, дуги уже
 * заменены кривыми. Массивы переиспользуются между пересборками, поэтому читать
 * нужно только первые `opCount` операций и `pointCount` точек.
 */
export interface PathGeometry {
  readonly ops: Uint8Array;
  /** Координаты точек подряд: x, y, z. */
  readonly points: Float64Array;
  readonly opCount: number;
  readonly pointCount: number;
  /** Замыкать ли контур. Путь из двух точек (отрезок) не замыкается никогда. */
  readonly closed: boolean;
}

/**
 * Сборщик пути в переиспользуемые буферы. Первая команда всегда становится `move`:
 * если путь начинается с другой команды, он начинается в её конечной точке.
 */
export class PathBuilder implements PathGeometry {
  ops = new Uint8Array(8);
  points = new Float64Array(24);
  opCount = 0;
  pointCount = 0;
  closed = false;
  #x = 0;
  #y = 0;
  #z = 0;

  reset(): this {
    this.opCount = 0;
    this.pointCount = 0;
    this.closed = false;
    return this;
  }

  moveTo(x: number, y: number, z: number): this {
    this.#op(PathOp.move, 1);
    this.#point(x, y, z);
    return this;
  }

  lineTo(x: number, y: number, z: number): this {
    if (this.opCount === 0) return this.moveTo(x, y, z);
    this.#op(PathOp.line, 1);
    this.#point(x, y, z);
    return this;
  }

  bezierTo(
    c1x: number,
    c1y: number,
    c1z: number,
    c2x: number,
    c2y: number,
    c2z: number,
    x: number,
    y: number,
    z: number,
  ): this {
    if (this.opCount === 0) return this.moveTo(x, y, z);
    this.#op(PathOp.cubic, 3);
    this.#point(c1x, c1y, c1z);
    this.#point(c2x, c2y, c2z);
    this.#point(x, y, z);
    return this;
  }

  /** Четверть дуги из текущей точки к `(x, y, z)` через угол `(cx, cy, cz)`. */
  arcTo(cx: number, cy: number, cz: number, x: number, y: number, z: number): this {
    if (this.opCount === 0) return this.moveTo(x, y, z);
    const px = this.#x;
    const py = this.#y;
    const pz = this.#z;
    return this.bezierTo(
      px + (cx - px) * ARC_HANDLE,
      py + (cy - py) * ARC_HANDLE,
      pz + (cz - pz) * ARC_HANDLE,
      x + (cx - x) * ARC_HANDLE,
      y + (cy - y) * ARC_HANDLE,
      z + (cz - z) * ARC_HANDLE,
      x,
      y,
      z,
    );
  }

  /** Добавляет команды пути. */
  addCommands(commands: readonly PathCommand[]): this {
    for (const command of commands) {
      const p = command.point;
      switch (command.type) {
        case 'move':
          this.moveTo(p.x ?? 0, p.y ?? 0, p.z ?? 0);
          break;
        case 'line':
          this.lineTo(p.x ?? 0, p.y ?? 0, p.z ?? 0);
          break;
        case 'bezier': {
          const { control1: a, control2: b } = command;
          this.bezierTo(
            a.x ?? 0,
            a.y ?? 0,
            a.z ?? 0,
            b.x ?? 0,
            b.y ?? 0,
            b.z ?? 0,
            p.x ?? 0,
            p.y ?? 0,
            p.z ?? 0,
          );
          break;
        }
        case 'arc': {
          const c = command.corner;
          this.arcTo(c.x ?? 0, c.y ?? 0, c.z ?? 0, p.x ?? 0, p.y ?? 0, p.z ?? 0);
          break;
        }
      }
    }
    return this;
  }

  /**
   * Задаёт замыкание с учётом правила Zdog: путь из двух точек (один отрезок) не
   * замыкается, иначе обводка прошла бы по нему дважды.
   */
  finish(closed: boolean): this {
    const isSegment = this.opCount === 2 && this.ops[1] === PathOp.line;
    this.closed = closed && !isSegment;
    return this;
  }

  #op(op: PathOp, points: number): void {
    if (this.opCount === this.ops.length) {
      const ops = new Uint8Array(this.ops.length * 2);
      ops.set(this.ops);
      this.ops = ops;
    }
    const needed = (this.pointCount + points) * 3;
    if (needed > this.points.length) {
      const grown = new Float64Array(Math.max(needed, this.points.length * 2));
      grown.set(this.points);
      this.points = grown;
    }
    this.ops[this.opCount++] = op;
  }

  #point(x: number, y: number, z: number): void {
    const i = this.pointCount * 3;
    this.points[i] = x;
    this.points[i + 1] = y;
    this.points[i + 2] = z;
    this.pointCount++;
    this.#x = x;
    this.#y = y;
    this.#z = z;
  }
}
