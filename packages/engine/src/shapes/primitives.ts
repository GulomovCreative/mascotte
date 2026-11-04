import { TAU } from '@mascotte/math';
import type { PathBuilder } from './path.ts';
import { checkLength, Shape, type ShapeOptions } from './shape.ts';

/*
 * Плоские примитивы лежат в плоскости XY фигуры, центр — в начале координат,
 * лицевая сторона смотрит вдоль +z. Геометрия совпадает с Zdog.
 */

function checkInteger(name: string, value: number, min: number, max = Number.POSITIVE_INFINITY) {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.POSITIVE_INFINITY ? `не меньше ${min}` : `от ${min} до ${max}`;
    throw new RangeError(`${name} должно быть целым числом ${range}, получено ${value}.`);
  }
  return value;
}

export interface EllipseOptions extends ShapeOptions {
  /** Диаметр: задаёт ширину и высоту сразу. */
  diameter?: number;
  width?: number;
  height?: number;
  /** Сколько четвертей рисовать, по часовой стрелке от верхней точки: 1–4. */
  quarters?: number;
}

/** Эллипс или его часть из четвертей. По умолчанию не замкнут, как в Zdog. */
export class Ellipse extends Shape {
  #width: number;
  #height: number;
  #quarters: number;

  constructor(options: EllipseOptions = {}) {
    super(options, { closed: false });
    const diameter = checkLength('diameter', options.diameter ?? 1);
    this.#width = checkLength('width', options.width ?? diameter);
    this.#height = checkLength('height', options.height ?? diameter);
    this.#quarters = checkInteger('quarters', options.quarters ?? 4, 1, 4);
  }

  get width(): number {
    return this.#width;
  }
  set width(value: number) {
    if (checkLength('width', value) !== this.#width) {
      this.#width = value;
      this.invalidateGeometry();
    }
  }

  get height(): number {
    return this.#height;
  }
  set height(value: number) {
    if (checkLength('height', value) !== this.#height) {
      this.#height = value;
      this.invalidateGeometry();
    }
  }

  /** Задаёт ширину и высоту сразу. Читается как ширина. */
  get diameter(): number {
    return this.#width;
  }
  set diameter(value: number) {
    checkLength('diameter', value);
    this.width = value;
    this.height = value;
  }

  get quarters(): number {
    return this.#quarters;
  }
  set quarters(value: number) {
    if (checkInteger('quarters', value, 1, 4) !== this.#quarters) {
      this.#quarters = value;
      this.invalidateGeometry();
    }
  }

  protected buildPath(builder: PathBuilder): void {
    const x = this.#width / 2;
    const y = this.#height / 2;
    builder.moveTo(0, -y, 0).arcTo(x, -y, 0, x, 0, 0);
    if (this.#quarters > 1) builder.arcTo(x, y, 0, 0, y, 0);
    if (this.#quarters > 2) builder.arcTo(-x, y, 0, -x, 0, 0);
    if (this.#quarters > 3) builder.arcTo(-x, -y, 0, 0, -y, 0);
  }
}

export interface RectOptions extends ShapeOptions {
  width?: number;
  height?: number;
}

/** Прямоугольник. */
export class Rect extends Shape {
  #width: number;
  #height: number;

  constructor(options: RectOptions = {}) {
    super(options);
    this.#width = checkLength('width', options.width ?? 1);
    this.#height = checkLength('height', options.height ?? 1);
  }

  get width(): number {
    return this.#width;
  }
  set width(value: number) {
    if (checkLength('width', value) !== this.#width) {
      this.#width = value;
      this.invalidateGeometry();
    }
  }

  get height(): number {
    return this.#height;
  }
  set height(value: number) {
    if (checkLength('height', value) !== this.#height) {
      this.#height = value;
      this.invalidateGeometry();
    }
  }

  protected buildPath(builder: PathBuilder): void {
    const x = this.#width / 2;
    const y = this.#height / 2;
    builder.moveTo(-x, -y, 0).lineTo(x, -y, 0).lineTo(x, y, 0).lineTo(-x, y, 0);
  }
}

export interface RoundedRectOptions extends RectOptions {
  /** Радиус скругления. Ограничивается половиной меньшей стороны. */
  cornerRadius?: number;
}

/** Прямоугольник со скруглёнными углами. Путь возвращается в начало, поэтому не замкнут, как в Zdog. */
export class RoundedRect extends Shape {
  #width: number;
  #height: number;
  #cornerRadius: number;

  constructor(options: RoundedRectOptions = {}) {
    super(options, { closed: false });
    this.#width = checkLength('width', options.width ?? 1);
    this.#height = checkLength('height', options.height ?? 1);
    this.#cornerRadius = checkLength('cornerRadius', options.cornerRadius ?? 0.25);
  }

  get width(): number {
    return this.#width;
  }
  set width(value: number) {
    if (checkLength('width', value) !== this.#width) {
      this.#width = value;
      this.invalidateGeometry();
    }
  }

  get height(): number {
    return this.#height;
  }
  set height(value: number) {
    if (checkLength('height', value) !== this.#height) {
      this.#height = value;
      this.invalidateGeometry();
    }
  }

  get cornerRadius(): number {
    return this.#cornerRadius;
  }
  set cornerRadius(value: number) {
    if (checkLength('cornerRadius', value) !== this.#cornerRadius) {
      this.#cornerRadius = value;
      this.invalidateGeometry();
    }
  }

  protected buildPath(builder: PathBuilder): void {
    const xA = this.#width / 2;
    const yA = this.#height / 2;
    const radius = Math.min(this.#cornerRadius, xA, yA);
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

/** Правильный многоугольник. Первая вершина — сверху. */
export class Polygon extends Shape {
  #radius: number;
  #sides: number;

  constructor(options: PolygonOptions = {}) {
    super(options);
    this.#radius = checkLength('radius', options.radius ?? 0.5);
    this.#sides = checkInteger('sides', options.sides ?? 3, 3);
  }

  get radius(): number {
    return this.#radius;
  }
  set radius(value: number) {
    if (checkLength('radius', value) !== this.#radius) {
      this.#radius = value;
      this.invalidateGeometry();
    }
  }

  get sides(): number {
    return this.#sides;
  }
  set sides(value: number) {
    if (checkInteger('sides', value, 3) !== this.#sides) {
      this.#sides = value;
      this.invalidateGeometry();
    }
  }

  protected buildPath(builder: PathBuilder): void {
    for (let i = 0; i < this.#sides; i++) {
      const theta = (i / this.#sides) * TAU - TAU / 4;
      builder.lineTo(Math.cos(theta) * this.#radius, Math.sin(theta) * this.#radius, 0);
    }
  }
}
