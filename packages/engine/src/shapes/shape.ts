import type { Vec3 } from '@mascotte/math';
import { ObservedVec3 } from '../scene/observed.ts';
import type { ParamSchema } from './params.ts';
import {
  PathBuilder,
  type PathCommand,
  type PathGeometry,
  PathOp,
  type PathPoint,
} from './path.ts';
import { Styled, type StyledOptions } from './styled.ts';

export interface ShapeOptions extends StyledOptions {
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
 * Числовые параметры примитивов описаны статической схемой `params`: подклассы
 * объявляют схему, переопределяют `buildPath` и читают и пишут параметры через
 * `getParam` и `setParam`, имена которых проверяет компилятор.
 */
export abstract class Shape<S extends ParamSchema = ParamSchema> extends Styled<S> {
  /** Замкнут ли контур по умолчанию. */
  static readonly defaultClosed: boolean = true;

  /** Направление лицевой стороны. Его изменение меняет только внешний вид. */
  readonly front: ObservedVec3;

  #closed: boolean;
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
  readonly #sortPoint: Vec3 = { x: 0, y: 0, z: 0 };
  #sortPointVersion = -1;

  constructor(options: ShapeOptions = {}) {
    super(options);
    const front = options.front ?? { x: 0, y: 0, z: 1 };
    this.front = new ObservedVec3(() => this.markAppearanceChanged(), front.x, front.y, front.z);
    this.#closed = options.closed ?? (this.constructor as typeof Shape).defaultClosed;
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

  /**
   * Точка сортировки — среднее концов команд пути, как в Zdog. Если путь возвращается
   * в начальную точку, повтор не учитывается.
   */
  override getSortPoint(out: Vec3): Vec3 {
    const version = this.geometryVersion;
    const point = this.#sortPoint;
    if (version !== this.#sortPointVersion) {
      const { ops, points, opCount } = this.geometry;
      let x = 0;
      let y = 0;
      let z = 0;
      let index = 0;
      let firstX = 0;
      let firstY = 0;
      let firstZ = 0;
      let lastX = 0;
      let lastY = 0;
      let lastZ = 0;
      for (let op = 0; op < opCount; op++) {
        index += ops[op] === PathOp.cubic ? 3 : 1;
        const i = (index - 1) * 3;
        lastX = points[i] ?? 0;
        lastY = points[i + 1] ?? 0;
        lastZ = points[i + 2] ?? 0;
        if (op === 0) {
          firstX = lastX;
          firstY = lastY;
          firstZ = lastZ;
        }
        x += lastX;
        y += lastY;
        z += lastZ;
      }
      let count = opCount;
      if (count > 2 && lastX === firstX && lastY === firstY && lastZ === firstZ) {
        x -= lastX;
        y -= lastY;
        z -= lastZ;
        count--;
      }
      point.x = x / count;
      point.y = y / count;
      point.z = z / count;
      this.#sortPointVersion = version;
    }
    out.x = point.x;
    out.y = point.y;
    out.z = point.z;
    return out;
  }

  /** Строит путь в локальных координатах. */
  protected abstract buildPath(builder: PathBuilder): void;

  /** Помечает геометрию устаревшей. */
  protected invalidateGeometry(): void {
    this.#geometryDirty = true;
  }

  protected onParamsChanged(): void {
    this.invalidateGeometry();
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
