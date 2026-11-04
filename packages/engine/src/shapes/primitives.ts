import { TAU } from '@mascotte/math';
import { checkLength, type ParamSchema } from './params.ts';
import type { PathBuilder } from './path.ts';
import { Shape, type ShapeOptions } from './shape.ts';

/*
 * Плоские примитивы лежат в плоскости XY фигуры, центр — в начале координат,
 * лицевая сторона смотрит вдоль +z. Геометрия совпадает с Zdog.
 */

export interface EllipseOptions extends ShapeOptions {
  /** Диаметр: значение по умолчанию для ширины и высоты. */
  diameter?: number;
  width?: number;
  height?: number;
  /** Сколько четвертей рисовать, по часовой стрелке от верхней точки: 1–4. */
  quarters?: number;
}

const ELLIPSE_PARAMS = {
  width: { kind: 'length', default: 1 },
  height: { kind: 'length', default: 1 },
  quarters: { kind: 'integer', default: 4, min: 1, max: 4 },
} as const satisfies ParamSchema;

/** Эллипс или его часть из четвертей. По умолчанию не замкнут, как в Zdog. */
export class Ellipse extends Shape<typeof ELLIPSE_PARAMS> {
  static override readonly params = ELLIPSE_PARAMS;
  static override readonly defaultClosed = false;

  constructor(options: EllipseOptions = {}) {
    super(options);
    if (options.diameter !== undefined) {
      const diameter = checkLength('diameter', options.diameter);
      if (options.width === undefined) this.setParam('width', diameter);
      if (options.height === undefined) this.setParam('height', diameter);
    }
  }

  get width(): number {
    return this.getParam('width');
  }
  set width(value: number) {
    this.setParam('width', value);
  }

  get height(): number {
    return this.getParam('height');
  }
  set height(value: number) {
    this.setParam('height', value);
  }

  /** Задаёт ширину и высоту сразу; при чтении возвращает ширину. */
  get diameter(): number {
    return this.width;
  }
  set diameter(value: number) {
    checkLength('diameter', value);
    this.width = value;
    this.height = value;
  }

  get quarters(): number {
    return this.getParam('quarters');
  }
  set quarters(value: number) {
    this.setParam('quarters', value);
  }

  protected buildPath(builder: PathBuilder): void {
    const x = this.width / 2;
    const y = this.height / 2;
    const quarters = this.quarters;
    builder.moveTo(0, -y, 0).arcTo(x, -y, 0, x, 0, 0);
    if (quarters > 1) builder.arcTo(x, y, 0, 0, y, 0);
    if (quarters > 2) builder.arcTo(-x, y, 0, -x, 0, 0);
    if (quarters > 3) builder.arcTo(-x, -y, 0, 0, -y, 0);
  }
}

export interface RectOptions extends ShapeOptions {
  width?: number;
  height?: number;
}

const RECT_PARAMS = {
  width: { kind: 'length', default: 1 },
  height: { kind: 'length', default: 1 },
} as const satisfies ParamSchema;

/** Прямоугольник. */
export class Rect<S extends typeof RECT_PARAMS = typeof RECT_PARAMS> extends Shape<S> {
  static override readonly params: ParamSchema = RECT_PARAMS;

  constructor(options: RectOptions = {}) {
    super(options);
  }

  get width(): number {
    return this.getParam('width');
  }
  set width(value: number) {
    this.setParam('width', value);
  }

  get height(): number {
    return this.getParam('height');
  }
  set height(value: number) {
    this.setParam('height', value);
  }

  protected buildPath(builder: PathBuilder): void {
    const x = this.width / 2;
    const y = this.height / 2;
    builder.moveTo(-x, -y, 0).lineTo(x, -y, 0).lineTo(x, y, 0).lineTo(-x, y, 0);
  }
}

export interface RoundedRectOptions extends RectOptions {
  /** Радиус скругления. Ограничивается половиной меньшей стороны. */
  cornerRadius?: number;
}

const ROUNDED_RECT_PARAMS = {
  ...RECT_PARAMS,
  cornerRadius: { kind: 'length', default: 0.25 },
} as const satisfies ParamSchema;

/** Прямоугольник со скруглёнными углами. Путь возвращается в начало, поэтому не замкнут, как в Zdog. */
export class RoundedRect extends Rect<typeof ROUNDED_RECT_PARAMS> {
  static override readonly params: ParamSchema = ROUNDED_RECT_PARAMS;
  static override readonly defaultClosed = false;

  constructor(options: RoundedRectOptions = {}) {
    super(options);
  }

  get cornerRadius(): number {
    return this.getParam('cornerRadius');
  }
  set cornerRadius(value: number) {
    this.setParam('cornerRadius', value);
  }

  protected override buildPath(builder: PathBuilder): void {
    const xA = this.width / 2;
    const yA = this.height / 2;
    const radius = Math.min(this.cornerRadius, xA, yA);
    const xB = xA - radius;
    const yB = yA - radius;
    builder.moveTo(xB, -yA, 0).arcTo(xA, -yA, 0, xA, -yB, 0);
    if (yB) builder.lineTo(xA, yB, 0);
    builder.arcTo(xA, yA, 0, xB, yA, 0);
    if (xB) builder.lineTo(-xB, yA, 0);
    builder.arcTo(-xA, yA, 0, -xA, yB, 0);
    if (yB) builder.lineTo(-xA, -yB, 0);
    builder.arcTo(-xA, -yA, 0, -xB, -yA, 0);
    if (xB) builder.lineTo(xB, -yA, 0);
  }
}

export interface PolygonOptions extends ShapeOptions {
  /** Радиус описанной окружности. */
  radius?: number;
  /** Число сторон, не меньше 3. */
  sides?: number;
}

const POLYGON_PARAMS = {
  radius: { kind: 'length', default: 0.5 },
  sides: { kind: 'integer', default: 3, min: 3 },
} as const satisfies ParamSchema;

/** Правильный многоугольник. Первая вершина — сверху. */
export class Polygon extends Shape<typeof POLYGON_PARAMS> {
  static override readonly params = POLYGON_PARAMS;

  constructor(options: PolygonOptions = {}) {
    super(options);
  }

  get radius(): number {
    return this.getParam('radius');
  }
  set radius(value: number) {
    this.setParam('radius', value);
  }

  get sides(): number {
    return this.getParam('sides');
  }
  set sides(value: number) {
    this.setParam('sides', value);
  }

  protected buildPath(builder: PathBuilder): void {
    const sides = this.sides;
    const radius = this.radius;
    for (let i = 0; i < sides; i++) {
      const theta = (i / sides) * TAU - TAU / 4;
      builder.lineTo(Math.cos(theta) * radius, Math.sin(theta) * radius, 0);
    }
  }
}
