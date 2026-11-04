import type { Vec3 } from '@mascotte/math';
import { Node, type NodeOptions } from '../scene/node.ts';
import { ObservedVec3 } from '../scene/observed.ts';
import { checkLength, type ParamSchema, ParamStore } from './params.ts';
import { PathBuilder, type PathCommand, type PathGeometry, type PathPoint } from './path.ts';

/** Значения стиля фигуры. */
export interface ShapeStyleValues {
  /** Толщина обводки в единицах сцены; 0 — без обводки. */
  stroke: number;
  fill: boolean;
  /** Цвет CSS. */
  color: string;
  /** Рисовать ли обратную сторону. */
  backfaceVisible: boolean;
  /** Цвет обратной стороны; `null` — тот же, что у лицевой. */
  backfaceColor: string | null;
}

/**
 * Стиль фигуры одним объектом: так его проще сохранять в документ и позже заменить
 * цвет материалом. Каждое изменение увеличивает `appearanceVersion` фигуры.
 */
export class ShapeStyle implements ShapeStyleValues {
  static readonly params = {
    stroke: { kind: 'length', default: 1 },
    fill: { kind: 'boolean', default: false },
    color: { kind: 'color', default: '#333' },
    backfaceVisible: { kind: 'boolean', default: true },
    backfaceColor: { kind: 'optionalColor', default: null },
  } as const satisfies ParamSchema;

  #stroke: number;
  #fill: boolean;
  #color: string;
  #backfaceVisible: boolean;
  #backfaceColor: string | null;
  readonly #onChange: () => void;

  constructor(onChange: () => void, values: Partial<ShapeStyleValues> = {}) {
    const p = ShapeStyle.params;
    this.#onChange = onChange;
    this.#stroke = checkLength('stroke', values.stroke ?? p.stroke.default);
    this.#fill = values.fill ?? p.fill.default;
    this.#color = values.color ?? p.color.default;
    this.#backfaceVisible = values.backfaceVisible ?? p.backfaceVisible.default;
    this.#backfaceColor = values.backfaceColor ?? p.backfaceColor.default;
  }

  get stroke(): number {
    return this.#stroke;
  }
  set stroke(value: number) {
    if (checkLength('stroke', value) !== this.#stroke) {
      this.#stroke = value;
      this.#onChange();
    }
  }

  get fill(): boolean {
    return this.#fill;
  }
  set fill(value: boolean) {
    if (value !== this.#fill) {
      this.#fill = value;
      this.#onChange();
    }
  }

  get color(): string {
    return this.#color;
  }
  set color(value: string) {
    if (value !== this.#color) {
      this.#color = value;
      this.#onChange();
    }
  }

  get backfaceVisible(): boolean {
    return this.#backfaceVisible;
  }
  set backfaceVisible(value: boolean) {
    if (value !== this.#backfaceVisible) {
      this.#backfaceVisible = value;
      this.#onChange();
    }
  }

  get backfaceColor(): string | null {
    return this.#backfaceColor;
  }
  set backfaceColor(value: string | null) {
    if (value !== this.#backfaceColor) {
      this.#backfaceColor = value;
      this.#onChange();
    }
  }
}

export interface ShapeOptions extends NodeOptions {
  style?: Partial<ShapeStyleValues>;
  /** Замыкать ли контур. По умолчанию — `defaultClosed` класса фигуры. */
  closed?: boolean;
  /** Направление лицевой стороны в локальных координатах. */
  front?: Readonly<Vec3>;
}

/**
 * Фигура: узел с одним путём и одним стилем. Геометрия строится лениво, в локальных
 * координатах, и пересобирается только после изменения параметров. Изменение
 * трансформации её не трогает: проекция использует мировую матрицу.
 *
 * Числовые параметры примитивов описаны статической схемой `params` и хранятся
 * в общем хранилище: подклассы объявляют схему, переопределяют `buildPath` и читают
 * и пишут параметры через `getParam` и `setParam`.
 */
export abstract class Shape extends Node {
  /** Схема числовых параметров фигуры. */
  static readonly params: ParamSchema = {};
  /** Замкнут ли контур по умолчанию. */
  static readonly defaultClosed: boolean = true;

  readonly style: ShapeStyle;
  /** Направление лицевой стороны. Его изменение меняет только внешний вид. */
  readonly front: ObservedVec3;

  #closed: boolean;
  readonly #params: ParamStore;
  readonly #builder = new PathBuilder();
  readonly #view: { -readonly [K in keyof PathGeometry]: PathGeometry[K] } = {
    ops: new Uint8Array(0),
    points: new Float64Array(0),
    opCount: 0,
    pointCount: 0,
    closed: false,
  };
  #geometryDirty = true;
  #geometryVersion = 0;

  constructor(options: ShapeOptions = {}) {
    super(options);
    const markAppearance = () => this.markAppearanceChanged();
    this.style = new ShapeStyle(markAppearance, options.style);
    const front = options.front ?? { x: 0, y: 0, z: 1 };
    this.front = new ObservedVec3(markAppearance, front.x, front.y, front.z);
    const type = this.constructor as typeof Shape;
    this.#closed = options.closed ?? type.defaultClosed;
    this.#params = new ParamStore(type.params, options, () => this.invalidateGeometry());
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

  /**
   * Геометрия пути в локальных координатах. Пересобирается лениво; объект всегда
   * один и тот же, а его поля обновляются при пересборке.
   */
  get geometry(): PathGeometry {
    if (this.#geometryDirty) {
      const builder = this.#builder.reset();
      this.buildPath(builder);
      builder.finish(this.#closed);
      const view = this.#view;
      view.ops = builder.ops;
      view.points = builder.points;
      view.opCount = builder.opCount;
      view.pointCount = builder.pointCount;
      view.closed = builder.closed;
      this.#geometryDirty = false;
      this.#geometryVersion++;
    }
    return this.#view;
  }

  /** Счётчик пересборок геометрии. Чтение сначала пересобирает устаревшую геометрию. */
  get geometryVersion(): number {
    this.geometry;
    return this.#geometryVersion;
  }

  /** Строит путь в локальных координатах. */
  protected abstract buildPath(builder: PathBuilder): void;

  /** Помечает геометрию устаревшей. */
  protected invalidateGeometry(): void {
    this.#geometryDirty = true;
  }

  /** Значение числового параметра из схемы `params`. */
  protected getParam(name: string): number {
    return this.#params.get(name);
  }

  /** Проверяет и записывает числовой параметр; при изменении помечает геометрию устаревшей. */
  protected setParam(name: string, value: number): void {
    this.#params.set(name, value);
  }
}

export interface PathShapeOptions extends ShapeOptions {
  /** Команды пути. По умолчанию — одна точка в начале координат, то есть круглая точка. */
  path?: readonly PathCommand[];
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
  /**
   * Новый путь. Команды и точки копируются и замораживаются, поэтому изменение
   * исходных объектов на фигуру не влияет: менять путь можно только присваиванием.
   */
  set path(value: readonly PathCommand[]) {
    this.#path = freezePath(value);
    this.invalidateGeometry();
  }

  protected buildPath(builder: PathBuilder): void {
    builder.addCommands(this.#path);
  }
}

function freezePoint(point: PathPoint): Required<PathPoint> {
  return Object.freeze({ x: point.x ?? 0, y: point.y ?? 0, z: point.z ?? 0 });
}

function freezeCommand(command: PathCommand): PathCommand {
  switch (command.type) {
    case 'move':
    case 'line':
      return Object.freeze({ type: command.type, point: freezePoint(command.point) });
    case 'bezier':
      return Object.freeze({
        type: 'bezier',
        control1: freezePoint(command.control1),
        control2: freezePoint(command.control2),
        point: freezePoint(command.point),
      });
    case 'arc':
      return Object.freeze({
        type: 'arc',
        corner: freezePoint(command.corner),
        point: freezePoint(command.point),
      });
  }
}

function freezePath(path: readonly PathCommand[]): readonly PathCommand[] {
  if (path.length === 0) throw new RangeError('Путь не может быть пустым.');
  return Object.freeze(path.map(freezeCommand));
}

const DOT: readonly PathCommand[] = [{ type: 'move', point: {} }];
