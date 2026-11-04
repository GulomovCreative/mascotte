import { type Mat3x4, mat3x4, type Vec3 } from '@mascotte/math';
import { Node, type NodeOptions } from './node.ts';

/**
 * Проекция камеры.
 * - `orthographic` — без перспективы: размер не зависит от глубины, как в Zdog.
 * - `perspective` — слабая перспектива: всё, что ближе к камере, крупнее. Масштаб
 *   зависит от глубины опорной точки, поэтому фигуру можно масштабировать целиком
 *   по глубине её центра, и круги остаются кругами.
 */
export type Projection = 'orthographic' | 'perspective';

export interface CameraOptions extends NodeOptions {
  projection?: Projection;
  /** Увеличение: во сколько раз единица сцены больше пикселя. */
  zoom?: number;
  /**
   * Расстояние от камеры до плоскости, где перспектива не меняет размер (глубина 0
   * в пространстве камеры). Чем меньше, тем сильнее перспектива.
   */
  distance?: number;
}

/** Точка после проекции: экранные координаты относительно центра кадра. */
export interface ProjectedPoint {
  /** Вправо, в пикселях до учёта devicePixelRatio. */
  x: number;
  /** Вниз, в пикселях до учёта devicePixelRatio. */
  y: number;
  /** Глубина в пространстве камеры: больше — ближе к зрителю. */
  depth: number;
  /** Во сколько раз размеры в этой точке увеличены (зум и перспектива). Для толщины обводок. */
  scale: number;
}

export function createProjectedPoint(): ProjectedPoint {
  return { x: 0, y: 0, depth: 0, scale: 1 };
}

function checkPositive(name: string, value: number): number {
  if (!(value > 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} должно быть положительным конечным числом, получено ${value}.`);
  }
  return value;
}

/**
 * Камера — узел сцены. Её мировая матрица задаёт положение и поворот взгляда, поэтому
 * камеру можно двигать, вращать вокруг маскота или прикреплять к узлам рига.
 *
 * Система координат как в Zdog: x вправо, y вниз, z к зрителю. Камера смотрит вдоль −z
 * своей локальной системы. Пространство камеры получается обратной мировой матрицей.
 * Масштаб узла камеры не используется для увеличения — для этого есть `zoom`.
 */
export class Camera extends Node {
  #projection: Projection;
  #zoom: number;
  #distance: number;
  #projectionVersion = 0;

  readonly #view: Mat3x4 = mat3x4.create();
  #viewSource = -1;

  constructor(options: CameraOptions = {}) {
    super(options);
    this.#projection = options.projection ?? 'orthographic';
    this.#zoom = checkPositive('zoom', options.zoom ?? 1);
    this.#distance = checkPositive('distance', options.distance ?? 1000);
  }

  get projection(): Projection {
    return this.#projection;
  }
  set projection(value: Projection) {
    if (value !== this.#projection) {
      this.#projection = value;
      this.#projectionVersion++;
    }
  }

  get zoom(): number {
    return this.#zoom;
  }
  set zoom(value: number) {
    if (checkPositive('zoom', value) !== this.#zoom) {
      this.#zoom = value;
      this.#projectionVersion++;
    }
  }

  get distance(): number {
    return this.#distance;
  }
  set distance(value: number) {
    if (checkPositive('distance', value) !== this.#distance) {
      this.#distance = value;
      this.#projectionVersion++;
    }
  }

  /** Счётчик изменений проекции (`projection`, `zoom`, `distance`). */
  get projectionVersion(): number {
    return this.#projectionVersion;
  }

  /**
   * Матрица из мировых координат в пространство камеры: обратная мировой матрице камеры.
   * Пересчитывается только после изменения положения камеры или её предков.
   * Бросает ошибку, если мировая матрица камеры вырождена (например, масштаб 0).
   */
  get viewMatrix(): Readonly<Mat3x4> {
    const version = this.worldVersion;
    if (version !== this.#viewSource) {
      if (!mat3x4.invert(this.#view, this.worldMatrix)) {
        throw new Error(`Мировая матрица камеры «${this.id}» вырождена.`);
      }
      this.#viewSource = version;
    }
    return this.#view;
  }

  /**
   * Увеличение для точки на глубине `depth` пространства камеры. В ортографии равно
   * `zoom`. В перспективе растёт к камере и стремится к бесконечности у её плоскости.
   */
  scaleAt(depth: number): number {
    if (this.#projection === 'orthographic') return this.#zoom;
    return (this.#zoom * this.#distance) / (this.#distance - depth);
  }

  /** Видна ли точка на глубине `depth`: в перспективе всё, что у камеры или за ней, не видно. */
  isInFront(depth: number): boolean {
    return this.#projection === 'orthographic' || depth < this.#distance;
  }

  /**
   * Проецирует точку пространства камеры. Если задана `referenceDepth`, масштаб берётся
   * по ней, а не по глубине самой точки: так вся фигура масштабируется одинаково (слабая
   * перспектива). Возвращает `false` и не трогает `out`, если опорная точка не видна.
   */
  projectView(out: ProjectedPoint, view: Readonly<Vec3>, referenceDepth = view.z): boolean {
    if (!this.isInFront(referenceDepth)) return false;
    const scale = this.scaleAt(referenceDepth);
    out.x = view.x * scale;
    out.y = view.y * scale;
    out.depth = view.z;
    out.scale = scale;
    return true;
  }

  /** Проецирует мировую точку. Смысл `referenceDepth` и результата — как у `projectView`. */
  project(out: ProjectedPoint, world: Readonly<Vec3>, referenceDepth?: number): boolean {
    mat3x4.transformPoint(viewScratch, this.viewMatrix, world);
    return this.projectView(out, viewScratch, referenceDepth ?? viewScratch.z);
  }

  /** Переводит мировую точку в пространство камеры. */
  toView(out: Vec3, world: Readonly<Vec3>): Vec3 {
    return mat3x4.transformPoint(out, this.viewMatrix, world);
  }
}

const viewScratch: Vec3 = { x: 0, y: 0, z: 0 };
