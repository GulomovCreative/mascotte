import type { Vec3 } from '@mascotte/math';
import { Node, type NodeOptions } from '../scene/node.ts';
import { ObservedVec3 } from '../scene/observed.ts';
import { PathBuilder, type PathCommand, type PathGeometry } from './path.ts';

export interface ShapeOptions extends NodeOptions {
  /** Толщина обводки в единицах сцены; 0 — без обводки. */
  stroke?: number;
  fill?: boolean;
  /** Цвет CSS. */
  color?: string;
  closed?: boolean;
  /**
   * Обратная сторона: `true` — рисовать как лицевую, `false` — не рисовать, строка —
   * рисовать этим цветом.
   */
  backface?: boolean | string;
  /** Направление лицевой стороны в локальных координатах. */
  front?: Readonly<Vec3>;
}

export interface PathShapeOptions extends ShapeOptions {
  /** Команды пути. По умолчанию — одна точка в начале координат, то есть круглая точка. */
  path?: readonly PathCommand[];
}

/** Проверяет, что значение — конечное неотрицательное число. */
export function checkLength(name: string, value: number): number {
  if (!(value >= 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} должно быть конечным неотрицательным числом, получено ${value}.`);
  }
  return value;
}

/**
 * Фигура: узел с путём и стилем. Геометрия строится лениво, в локальных координатах,
 * и пересобирается только после изменения параметров. Изменение трансформации её не
 * трогает: проекция использует мировую матрицу.
 *
 * Подклассы-примитивы переопределяют `buildPath` и вызывают `invalidateGeometry`
 * из сеттеров своих параметров.
 */
export abstract class Shape extends Node {
  #stroke: number;
  #fill: boolean;
  #color: string;
  #closed: boolean;
  #backface: boolean | string;
  /** Направление лицевой стороны. Его изменение меняет только внешний вид. */
  readonly front: ObservedVec3;

  readonly #builder = new PathBuilder();
  #geometryDirty = true;
  #geometryVersion = 0;

  constructor(options: ShapeOptions = {}, defaults: { closed: boolean } = { closed: true }) {
    super(options);
    this.#stroke = checkLength('stroke', options.stroke ?? 1);
    this.#fill = options.fill ?? false;
    this.#color = options.color ?? '#333';
    this.#closed = options.closed ?? defaults.closed;
    this.#backface = options.backface ?? true;
    const front = options.front ?? { x: 0, y: 0, z: 1 };
    this.front = new ObservedVec3(() => this.markAppearanceChanged(), front.x, front.y, front.z);
  }

  get stroke(): number {
    return this.#stroke;
  }
  set stroke(value: number) {
    if (checkLength('stroke', value) !== this.#stroke) {
      this.#stroke = value;
      this.markAppearanceChanged();
    }
  }

  get fill(): boolean {
    return this.#fill;
  }
  set fill(value: boolean) {
    if (value !== this.#fill) {
      this.#fill = value;
      this.markAppearanceChanged();
    }
  }

  get color(): string {
    return this.#color;
  }
  set color(value: string) {
    if (value !== this.#color) {
      this.#color = value;
      this.markAppearanceChanged();
    }
  }

  get backface(): boolean | string {
    return this.#backface;
  }
  set backface(value: boolean | string) {
    if (value !== this.#backface) {
      this.#backface = value;
      this.markAppearanceChanged();
    }
  }

  /** Замыкать ли контур. Влияет на геометрию. */
  get closed(): boolean {
    return this.#closed;
  }
  set closed(value: boolean) {
    if (value !== this.#closed) {
      this.#closed = value;
      this.invalidateGeometry();
    }
  }

  /** Геометрия пути в локальных координатах. Пересобирается лениво. */
  get geometry(): PathGeometry {
    if (this.#geometryDirty) {
      this.buildPath(this.#builder.reset());
      this.#builder.finish(this.#closed);
      this.#geometryDirty = false;
      this.#geometryVersion++;
    }
    return this.#builder;
  }

  /** Счётчик пересборок геометрии. Чтение сначала пересобирает устаревшую геометрию. */
  get geometryVersion(): number {
    this.geometry;
    return this.#geometryVersion;
  }

  /** Строит путь в локальных координатах. */
  protected abstract buildPath(builder: PathBuilder): void;

  /** Помечает геометрию устаревшей. Вызывается из сеттеров параметров. */
  protected invalidateGeometry(): void {
    this.#geometryDirty = true;
  }
}

/**
 * Фигура с произвольным путём. Без пути это круглая точка размером с обводку,
 * путь из двух точек — отрезок.
 */
export class PathShape extends Shape {
  #path: readonly PathCommand[];

  constructor(options: PathShapeOptions = {}) {
    super(options);
    this.#path = freezePath(options.path ?? DOT);
  }

  get path(): readonly PathCommand[] {
    return this.#path;
  }
  /** Новый путь. Массив копируется и замораживается: менять путь можно только присваиванием. */
  set path(value: readonly PathCommand[]) {
    this.#path = freezePath(value);
    this.invalidateGeometry();
  }

  protected buildPath(builder: PathBuilder): void {
    builder.addCommands(this.#path);
  }
}

const DOT: readonly PathCommand[] = Object.freeze([
  Object.freeze({ type: 'move', point: Object.freeze({}) }),
]);

function freezePath(path: readonly PathCommand[]): readonly PathCommand[] {
  if (path.length === 0) throw new RangeError('Путь не может быть пустым.');
  return Object.freeze(path.slice());
}
