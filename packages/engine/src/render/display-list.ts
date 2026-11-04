import { mat3x4, TAU, type Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import type { Scene } from '../scene/scene.ts';
import { PathOp } from '../shapes/path.ts';
import { Shape } from '../shapes/shape.ts';
import { SurfaceOutline } from '../shapes/surface.ts';
import { DepthSorter, type Drawable } from './depth-sort.ts';

/**
 * Элемент списка отрисовки: путь в пикселях относительно центра кадра, кисть и
 * прозрачность. Объекты переиспользуются между кадрами.
 */
export class DisplayItem extends SurfaceOutline {
  /** Узел, из которого получен элемент: для отладки и поиска под курсором. */
  node: Drawable | null = null;
  /** Итоговая непрозрачность с учётом предков. */
  opacity = 1;
}

const modelView = mat3x4.create();
const point: Vec3 = { x: 0, y: 0, z: 0 };
const front: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Список отрисовки кадра: что и в каком порядке рисовать. Строится из сцены и камеры:
 * сортировка по глубине, проекция путей фигур, контуры поверхностей, обратные стороны,
 * прозрачность. Бэкенд рисует готовый список без знания о сцене.
 *
 * Элементы и их буферы переиспользуются, поэтому в обычном кадре объекты не создаются.
 */
export class DisplayList {
  readonly #sorter = new DepthSorter();
  readonly #items: DisplayItem[] = [];
  #count = 0;

  /** Число элементов после последней сборки. */
  get count(): number {
    return this.#count;
  }

  /** Элемент `index` из первых `count`. */
  item(index: number): DisplayItem {
    const item = this.#items[index];
    if (!item || index >= this.#count) throw new RangeError(`Нет элемента ${index}.`);
    return item;
  }

  build(scene: Scene, camera: Camera): this {
    this.#count = 0;
    for (const drawable of this.#sorter.sort(scene, camera)) {
      const opacity = drawable.worldOpacity;
      if (opacity <= 0) continue;
      const item = this.#next();
      const ready =
        drawable instanceof Shape
          ? projectShape(drawable, camera, item)
          : drawable.buildOutline(camera, item);
      if (!ready || !(item.hasStroke || item.hasFill)) continue;
      item.node = drawable;
      item.opacity = opacity;
      this.#count++;
    }
    return this;
  }

  #next(): DisplayItem {
    let item = this.#items[this.#count];
    if (!item) {
      item = new DisplayItem();
      this.#items.push(item);
    }
    return item;
  }
}

/**
 * Проецирует путь фигуры в экранные координаты. Возвращает `false`, если рисовать
 * нечего: обратная сторона скрыта, фигура за глазом камеры или путь — точка без обводки.
 */
function projectShape(shape: Shape, camera: Camera, out: DisplayItem): boolean {
  const style = shape.style;

  // Обратная сторона: точка `front` ближе к камере, чем начало, — лицевая.
  shape.localToWorld(point, ORIGIN);
  const originDepth = camera.toView(point, point).z;
  front.x = shape.front.x;
  front.y = shape.front.y;
  front.z = shape.front.z;
  shape.localToWorld(point, front);
  const facingBack = camera.toView(point, point).z <= originDepth;
  if (facingBack && !style.backfaceVisible) return false;

  camera.toView(point, shape.perspectiveReference.getWorldPosition(point));
  if (!camera.isInFront(point.z)) return false;
  const s = camera.scaleAt(point.z);

  mat3x4.multiply(modelView, camera.viewMatrix, shape.worldMatrix);
  // Масштаб узла для обводки: кубический корень из определителя, точный для равномерного масштаба.
  const nodeScale = Math.cbrt(Math.abs(mat3x4.determinant(shape.worldMatrix)));
  const lineWidth = style.stroke * nodeScale * s;
  const color = facingBack ? (style.backfaceColor ?? style.color) : style.color;

  const { ops, points, opCount } = shape.geometry;
  const path = out.path.reset();
  out.color = color;
  out.lineCap = 'round';

  if (opCount === 1) {
    // Точка: круг диаметром в толщину обводки, как в Zdog.
    if (lineWidth <= 0) return false;
    project(points, 0);
    path.arc(point.x * s, point.y * s, lineWidth / 2, 0, TAU).close();
    out.lineWidth = 0;
    out.hasStroke = false;
    out.hasFill = true;
    return true;
  }

  let index = 0;
  for (let op = 0; op < opCount; op++) {
    const code = ops[op];
    if (code === PathOp.cubic) {
      project(points, index);
      const c1x = point.x * s;
      const c1y = point.y * s;
      project(points, index + 1);
      const c2x = point.x * s;
      const c2y = point.y * s;
      project(points, index + 2);
      path.cubicTo(c1x, c1y, c2x, c2y, point.x * s, point.y * s);
      index += 3;
    } else {
      project(points, index);
      if (code === PathOp.move) path.moveTo(point.x * s, point.y * s);
      else path.lineTo(point.x * s, point.y * s);
      index++;
    }
  }
  if (shape.geometry.closed) path.close();
  out.lineWidth = lineWidth;
  out.hasStroke = lineWidth > 0;
  out.hasFill = style.fill;
  return true;
}

/** Переводит точку `index` геометрии в пространство камеры (в `point`). */
function project(points: Float64Array, index: number): void {
  const i = index * 3;
  local.x = points[i] ?? 0;
  local.y = points[i + 1] ?? 0;
  local.z = points[i + 2] ?? 0;
  mat3x4.transformPoint(point, modelView, local);
}

const ORIGIN: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const local: Vec3 = { x: 0, y: 0, z: 0 };
