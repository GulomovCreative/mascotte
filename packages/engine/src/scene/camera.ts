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
  /** Увеличение: сколько пикселей занимает единица сцены. */
  zoom?: number;
  /**
   * Расстояние от глаза до узла камеры в перспективе. Узел — плоскость картинки, где
   * перспектива не меняет размер; глаз стоит на `distance` позади него, в локальной
   * точке `(0, 0, distance)`. Чем меньше расстояние, тем сильнее перспектива.
   */
  distance?: number;
}

/**
 * Точка после проекции: экранные координаты относительно центра кадра, в пикселях
 * (если `zoom` задан в пикселях на единицу сцены) до учёта devicePixelRatio.
 */
export interface ProjectedPoint {
  /** Вправо. */
  x: number;
  /** Вниз. */
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
 * Камера — узел сцены. Положение и поворот узла задают взгляд, поэтому камеру можно
 * двигать, вращать вокруг маскота или прикреплять к узлам рига.
 *
 * Система координат как в Zdog: x вправо, y вниз, z к зрителю. Камера смотрит вдоль −z
 * своей локальной системы. Узел камеры — это плоскость картинки и центр вращения:
 * точка в нём попадает в центр кадра с масштабом `zoom`. В перспективе глаз стоит на
 * `distance` позади узла (`getEyePosition`), как если бы Zdog-иллюстрацию снимали издали.
 *
 * Масштаб узла камеры и её предков в кадр не попадает: пространство камеры строится
 * только из положения и поворота. Поэтому камеру можно вешать на любой узел рига,
 * а увеличение задаётся только `zoom`.
 *
 * Камера входит в `Scene.nodes` как обычный узел; отрисовка её пропускает.
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
   * Матрица из мировых координат в пространство камеры: обратная к положению и повороту
   * узла, без масштаба и сдвига. Пересчитывается только после изменения положения камеры
   * или её предков. Бросает ошибку, если ось камеры вырождена (масштаб 0 по оси).
   */
  get viewMatrix(): Readonly<Mat3x4> {
    const version = this.worldVersion;
    if (version !== this.#viewSource) {
      rigidInverse(this.#view, this.worldMatrix, this.id);
      this.#viewSource = version;
    }
    return this.#view;
  }

  /**
   * Положение глаза в мировых координатах: точка `(0, 0, distance)` узла без учёта
   * масштаба. В ортографии глаза нет, возвращается `null`.
   */
  getEyePosition(out: Vec3): Vec3 | null {
    if (this.#projection === 'orthographic') return null;
    const view = this.viewMatrix;
    // Ось z камеры в мире — третья строка обратной матрицы поворота.
    const zx = view[2]!;
    const zy = view[5]!;
    const zz = view[8]!;
    const world = this.worldMatrix;
    out.x = world[9]! + zx * this.#distance;
    out.y = world[10]! + zy * this.#distance;
    out.z = world[11]! + zz * this.#distance;
    return out;
  }

  /**
   * Увеличение для точки на глубине `depth` пространства камеры. В ортографии равно
   * `zoom`. В перспективе растёт к глазу и стремится к бесконечности у плоскости глаза
   * (глубина `distance`). Для `depth ≥ distance` результат бессмыслен (бесконечный или
   * отрицательный): сначала проверяйте `isInFront`.
   */
  scaleAt(depth: number): number {
    if (this.#projection === 'orthographic') return this.#zoom;
    return (this.#zoom * this.#distance) / (this.#distance - depth);
  }

  /** Видна ли точка на глубине `depth`: в перспективе не видно всё, что на плоскости глаза или позади неё. */
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

/**
 * Обратная к жёсткой части матрицы `m`: столбцы линейной части ортонормируются
 * (Грам — Шмидт, третья ось как векторное произведение), масштаб, сдвиг и отражение
 * отбрасываются. Обратная к повороту — транспонированная.
 */
function rigidInverse(out: Mat3x4, m: Readonly<Mat3x4>, id: string): void {
  let xx = m[0]!;
  let xy = m[1]!;
  let xz = m[2]!;
  const xLength = Math.sqrt(xx * xx + xy * xy + xz * xz);
  let yx = m[3]!;
  let yy = m[4]!;
  let yz = m[5]!;
  if (xLength < 1e-12) throw new Error(`Ось x камеры «${id}» вырождена.`);
  xx /= xLength;
  xy /= xLength;
  xz /= xLength;
  const along = xx * yx + xy * yy + xz * yz;
  yx -= along * xx;
  yy -= along * xy;
  yz -= along * xz;
  const yLength = Math.sqrt(yx * yx + yy * yy + yz * yz);
  if (yLength < 1e-12) throw new Error(`Ось y камеры «${id}» вырождена.`);
  yx /= yLength;
  yy /= yLength;
  yz /= yLength;
  const zx = xy * yz - xz * yy;
  const zy = xz * yx - xx * yz;
  const zz = xx * yy - xy * yx;
  const tx = m[9]!;
  const ty = m[10]!;
  const tz = m[11]!;
  // Строки обратной матрицы — оси камеры в мире.
  out[0] = xx;
  out[3] = xy;
  out[6] = xz;
  out[1] = yx;
  out[4] = yy;
  out[7] = yz;
  out[2] = zx;
  out[5] = zy;
  out[8] = zz;
  out[9] = -(xx * tx + xy * ty + xz * tz);
  out[10] = -(yx * tx + yy * ty + yz * tz);
  out[11] = -(zx * tx + zy * ty + zz * tz);
}
