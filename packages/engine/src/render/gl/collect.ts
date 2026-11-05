import { color as colorMath, mat3x4, type Vec3 } from '@mascotte/math';
import type { Camera } from '../../scene/camera.ts';
import type { Node } from '../../scene/node.ts';
import type { Scene } from '../../scene/scene.ts';
import { PathOp } from '../../shapes/path.ts';
import { Ellipse, Rect } from '../../shapes/primitives.ts';
import { Shape } from '../../shapes/shape.ts';
import {
  Box,
  Capsule,
  Cone,
  ConeSurface,
  Cylinder,
  CylinderBody,
  Hemisphere,
  HemisphereDome,
  Solid,
  Sphere,
} from '../../shapes/solids.ts';
import { DepthSorter, type Drawable, isDrawable } from '../depth-sort.ts';
import { FloatBuffer, FrameList, IndexBuffer, Polyline } from './buffer.ts';
import { triangulate } from './triangulate.ts';

/*
 * Сборка кадра для WebGL2. Всё переводится в «экранное 3D»: x вправо и y вниз в пикселях
 * относительно центра кадра, z к зрителю в тех же пикселях (глубина умножена на тот же
 * масштаб перспективы). В этом пространстве лучи взгляда параллельны оси z, поэтому
 * форму и глубину шаров, капсул и поверхностей можно точно посчитать в каждом пикселе.
 */

/** Сколько чисел у экземпляра каждого вида. Цвет — последние четыре (RGBA, 0–1). */
export const STRIDE = {
  /** ax ay az, bx by bz, радиус, цвет */
  capsule: 11,
  /** cx cy cz, радиус, цвет */
  sphere: 8,
  /** cx cy cz, радиус, ось x y z (единичная, к куполу), цвет */
  hemisphere: 11,
  /** ax ay az, bx by bz, радиус, цвет */
  cylinder: 11,
  /** центр основания x y z, вершина x y z, радиус основания, цвет */
  cone: 11,
  /** вершина треугольника: x y z, цвет */
  fill: 7,
} as const;

export type PrimitiveKind = keyof typeof STRIDE;
export const PRIMITIVE_KINDS = Object.keys(STRIDE) as PrimitiveKind[];

/**
 * Корзина примитивов, которые рисуются одной группой вызовов: с одним значением
 * трафарета и одним режимом (обычный, декаль, полупрозрачный).
 */
export class Bucket {
  /** Номер опоры декалей в трафарете (1–127): у опоры — её номер, у декали — номер её опоры, иначе 0. */
  stencil = 0;
  /** Декаль: рисуется только поверх видимых пикселей опоры, без проверки глубины. */
  decal = false;
  /** Полупрозрачное: с наложением, без записи глубины, каждый пиксель смешивается один раз. */
  blend = false;
  readonly data: Record<PrimitiveKind, FloatBuffer> = {
    capsule: new FloatBuffer(),
    sphere: new FloatBuffer(),
    hemisphere: new FloatBuffer(),
    cylinder: new FloatBuffer(),
    cone: new FloatBuffer(),
    fill: new FloatBuffer(),
  };

  reset(): void {
    for (const kind of PRIMITIVE_KINDS) this.data[kind].reset();
  }

  count(kind: PrimitiveKind): number {
    return this.data[kind].length / STRIDE[kind];
  }
}

/**
 * Слой кадра — прогон слоёв сортировщика. Глубина проверяется только внутри слоя:
 * следующий слой рисуется поверх предыдущего.
 */
export interface GLLayer {
  /** Непрозрачные корзины: сначала обычная (трафарет 0), затем по одной на опору. */
  readonly opaque: readonly Bucket[];
  /** Декали в порядке сортировки, по корзине на фигуру. */
  readonly decals: readonly Bucket[];
  /** Полупрозрачные фигуры в порядке сортировки, по корзине на фигуру. */
  readonly transparent: readonly Bucket[];
}

/** Кадр: слои в порядке отрисовки и диапазон глубин. */
export interface GLFrame {
  readonly layers: readonly GLLayer[];
  /** Самая дальняя и самая ближняя глубина кадра в экранных пикселях. */
  readonly zMin: number;
  readonly zMax: number;
}

/** Сколько опор декалей помещается в одном слое: номер опоры занимает 7 бит трафарета. */
export const MAX_ANCHORS = 127;

class Layer implements GLLayer {
  readonly opaqueList = new FrameList<Bucket>();
  readonly decalList = new FrameList<Bucket>();
  readonly transparentList = new FrameList<Bucket>();
  anchors = 0;

  get opaque(): readonly Bucket[] {
    return this.opaqueList.items;
  }
  get decals(): readonly Bucket[] {
    return this.decalList.items;
  }
  get transparent(): readonly Bucket[] {
    return this.transparentList.items;
  }

  begin(): void {
    this.opaqueList.begin();
    this.decalList.begin();
    this.transparentList.begin();
    this.anchors = 0;
  }

  end(): void {
    this.opaqueList.end();
    this.decalList.end();
    this.transparentList.end();
  }
}

const colors = new Map<string, [number, number, number, number]>();
const parsed = colorMath.create();

/**
 * RGBA цвета CSS с кэшем. Неразборчивый цвет — пурпурный, чтобы ошибка была видна
 * на кадре; предупреждение в консоль — один раз на цвет.
 */
function rgba(css: string): [number, number, number, number] {
  let value = colors.get(css);
  if (!value) {
    const c = colorMath.parse(css, parsed);
    if (c) value = [c.r, c.g, c.b, c.a];
    else {
      value = [1, 0, 1, 1];
      console.warn(`Не удалось разобрать цвет «${css}», вместо него пурпурный.`);
    }
    colors.set(css, value);
  }
  return value;
}

/**
 * Опора декали: ближайший предок, на котором лежит декаль, — рисуемый узел или
 * составная фигура, которые сами не декали. Узел — декаль, если он сам или промежуточный
 * узел до опоры в режиме `attached`.
 */
export function decalAnchor(node: Node): Node | null {
  let attached = node.sortMode === 'attached';
  for (let p = node.parent; p; p = p.parent) {
    const anchor = (isDrawable(p) || p instanceof Solid) && p.sortMode !== 'attached';
    if (anchor) return attached ? p : null;
    if (p.sortMode === 'attached') attached = true;
  }
  return null;
}

const modelView = mat3x4.create();
// Мировая матрица текущего узла в пространстве камеры, без масштаба перспективы.
const nodeView = mat3x4.create();
const boxView = mat3x4.create();
const corner: Vec3 = { x: 0, y: 0, z: 0 };
const CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
];
const scratch: Vec3 = { x: 0, y: 0, z: 0 };
const local: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Сборщик кадра. Корзины, слои, буферы и сам объект кадра переиспользуются между
 * кадрами: результат действителен до следующего вызова `collect`.
 */
export class GLCollector {
  readonly #sorter = new DepthSorter();
  readonly #pool: Bucket[] = [];
  #used = 0;
  readonly #layerPool: Layer[] = [];
  readonly #layers = new FrameList<Layer>();
  // Номера опор декалей. Запись действительна, только если её кадр — текущий: так
  // таблицу не нужно очищать каждый кадр (очистка Map выделяет память). Сбрасывается
  // при смене сцены или её структуры, чтобы не держать удалённые узлы.
  readonly #anchors = new Map<Node, { frame: number; id: number }>();
  #anchorFrame = 0;
  #anchorScene: Scene | null = null;
  #anchorStructure = -1;
  #zMin = 0;
  #zMax = 0;
  #warnedAnchors = false;
  readonly #frame: { layers: readonly Layer[]; zMin: number; zMax: number } = {
    layers: this.#layers.items,
    zMin: 0,
    zMax: 0,
  };
  // Ломаная текущего контура в экранном 3D и индексы её треугольников.
  readonly #line = new Polyline();
  // Текущая фигура: камера, масштаб перспективы, радиус, непрозрачность, длина оси.
  #camera: Camera | null = null;
  #s = 1;
  #radius = 0;
  #opacity = 1;
  #axis = 1;
  readonly #triangles = new IndexBuffer();

  collect(scene: Scene, camera: Camera): GLFrame {
    this.#used = 0;
    this.#layers.begin();
    this.#anchorFrame++;
    if (scene !== this.#anchorScene || scene.structureVersion !== this.#anchorStructure) {
      this.#anchors.clear();
      this.#anchorScene = scene;
      this.#anchorStructure = scene.structureVersion;
    }
    this.#zMin = Number.POSITIVE_INFINITY;
    this.#zMax = Number.NEGATIVE_INFINITY;

    const drawables = this.#sorter.sort(scene, camera);
    const runs = this.#sorter.runs;
    // Номера опор: у каждой непрозрачной опоры декалей свой номер трафарета в её слое.
    // У полупрозрачной опоры номера нет: её декали тоже полупрозрачны (прозрачность
    // наследуется) и рисуются как обычные полупрозрачные фигуры.
    for (let i = 0; i < drawables.length; i++) {
      const anchor = decalAnchor(drawables[i] as Drawable);
      if (!anchor || this.#anchorId(anchor) !== 0 || anchor.worldOpacity < 1) continue;
      const layer = this.#layer(runs[i] ?? 0);
      if (layer.anchors < MAX_ANCHORS) this.#setAnchor(anchor, ++layer.anchors);
      else if (!this.#warnedAnchors) {
        this.#warnedAnchors = true;
        console.warn(
          `В слое больше ${MAX_ANCHORS} опор декалей; декали остальных рисуются как обычные фигуры.`,
        );
      }
    }
    for (let i = 0; i < drawables.length; i++) {
      const drawable = drawables[i] as Drawable;
      const opacity = drawable.worldOpacity;
      if (opacity <= 0) continue;
      const layer = this.#layer(runs[i] ?? 0);
      const anchor = decalAnchor(drawable);
      const anchorId = anchor ? this.#anchorId(anchor) : 0;
      let bucket: Bucket;
      if (anchorId !== 0) {
        // Декали рисуются без проверки глубины, строго по порядку сортировки, поэтому у
        // каждой своя корзина: внутри корзины примитивы идут по видам, а не по порядку.
        bucket = this.#bucket(layer.decalList, anchorId, true, opacity < 1);
      } else if (opacity < 1) {
        bucket = this.#bucket(layer.transparentList, 0, false, true);
      } else {
        const own =
          this.#anchorId(drawable) || (drawable.owner ? this.#anchorId(drawable.owner) : 0);
        bucket = this.#opaque(layer, own);
      }
      this.#emit(drawable, camera, bucket, opacity);
    }
    if (this.#zMin > this.#zMax) {
      this.#zMin = -1;
      this.#zMax = 1;
    }
    const layers = this.#layers;
    for (let i = 0; i < layers.count; i++) (layers.items[i] as Layer).end();
    layers.end();
    const frame = this.#frame;
    frame.zMin = this.#zMin;
    frame.zMax = this.#zMax;
    return frame;
  }

  /** Номер опоры в текущем кадре или 0. */
  #anchorId(node: Node): number {
    const entry = this.#anchors.get(node);
    return entry && entry.frame === this.#anchorFrame ? entry.id : 0;
  }

  #setAnchor(node: Node, id: number): void {
    const entry = this.#anchors.get(node);
    if (entry) {
      entry.frame = this.#anchorFrame;
      entry.id = id;
    } else this.#anchors.set(node, { frame: this.#anchorFrame, id });
  }

  /** Слой с номером прогона `run`; слои создаются по порядку, пропусков нет. */
  #layer(run: number): Layer {
    const layers = this.#layers;
    while (layers.count <= run) {
      let layer = this.#layerPool[layers.count];
      if (!layer) {
        layer = new Layer();
        this.#layerPool.push(layer);
      }
      layer.begin();
      layers.push(layer);
      // Обычная корзина слоя идёт первой.
      this.#bucket(layer.opaqueList, 0, false, false);
    }
    return layers.items[run] as Layer;
  }

  #bucket(list: FrameList<Bucket>, stencil: number, decal: boolean, blend: boolean): Bucket {
    let bucket = this.#pool[this.#used];
    if (!bucket) {
      bucket = new Bucket();
      this.#pool.push(bucket);
    }
    this.#used++;
    bucket.reset();
    bucket.stencil = stencil;
    bucket.decal = decal;
    bucket.blend = blend;
    list.push(bucket);
    return bucket;
  }

  #opaque(layer: Layer, stencil: number): Bucket {
    const list = layer.opaqueList;
    for (let i = 0; i < list.count; i++) {
      const bucket = list.items[i] as Bucket;
      if (bucket.stencil === stencil) return bucket;
    }
    return this.#bucket(list, stencil, false, false);
  }

  #extent(z: number, r: number): void {
    if (z - r < this.#zMin) this.#zMin = z - r;
    if (z + r > this.#zMax) this.#zMax = z + r;
  }

  /*
   * Дальше дробные числа не передаются в вызовы и не возвращаются из них: если V8 не
   * встроит вызов, каждое такое число упаковывается в объект, а вызовов — тысячи на кадр.
   * Масштаб перспективы и непрозрачность лежат в полях, точки узла считаются прямо по
   * его матрице в пространстве камеры (`nodeView`), данные пишутся в буфер по индексу.
   */

  /** Масштаб перспективы по опорному узлу в `#s`; `false`, если тот за глазом камеры. */
  #scale(drawable: Drawable, camera: Camera): boolean {
    camera.toView(scratch, drawable.perspectiveReference.getWorldPosition(scratch));
    if (!camera.isInFront(scratch.z)) return false;
    this.#s = camera.scaleAt(scratch.z);
    return true;
  }

  /**
   * Примитивы одной фигуры в `bucket` так же, как при сборке кадра: в экранном 3D,
   * с учётом обратной стороны и перспективы. Нужны проверке попадания.
   */
  emitDrawable(drawable: Drawable, camera: Camera, bucket: Bucket): void {
    this.#emit(drawable, camera, bucket, 1);
  }

  #emit(drawable: Drawable, camera: Camera, bucket: Bucket, opacity: number): void {
    if (!this.#scale(drawable, camera)) return;
    this.#opacity = opacity;
    this.#camera = camera;
    mat3x4.multiply(nodeView, camera.viewMatrix, drawable.worldMatrix);
    if (drawable instanceof Shape) this.#shape(drawable, bucket);
    else if (drawable instanceof Sphere) this.#sphere(drawable, bucket);
    else if (drawable instanceof Capsule) this.#capsule(drawable, bucket);
    else if (drawable instanceof HemisphereDome) this.#dome(drawable, bucket);
    else if (drawable instanceof CylinderBody) this.#cylinderBody(drawable, bucket);
    else if (drawable instanceof ConeSurface) this.#coneSurface(drawable, bucket);
  }

  /** Цвет `css` с непрозрачностью фигуры в `d` с индекса `o`. */
  #writeColor(d: Float32Array, o: number, css: string): void {
    const color = rgba(css);
    d[o] = color[0];
    d[o + 1] = color[1];
    d[o + 2] = color[2];
    d[o + 3] = color[3] * this.#opacity;
  }

  /** Шар с центром в `scratch` и радиусом `#radius`. */
  #pushSphere(bucket: Bucket, css: string): void {
    const out = bucket.data.sphere;
    const o = out.reserve(STRIDE.sphere);
    const d = out.data;
    const r = this.#radius;
    d[o] = scratch.x;
    d[o + 1] = scratch.y;
    d[o + 2] = scratch.z;
    d[o + 3] = r;
    this.#writeColor(d, o + 4, css);
    this.#extent(scratch.z, r);
  }

  /**
   * Отрезок вдоль локальной оси z узла: от `from` до `to` (в единицах узла), радиус
   * `#radius`. Для капсул и боков цилиндров.
   */
  #pushAxisSegment(out: FloatBuffer, from: number, to: number, css: string): void {
    const m = nodeView;
    const s = this.#s;
    const r = this.#radius;
    const o = out.reserve(STRIDE.capsule);
    const d = out.data;
    const tx = m[9] as number;
    const ty = m[10] as number;
    const tz = m[11] as number;
    const zx = m[6] as number;
    const zy = m[7] as number;
    const zz = m[8] as number;
    const az = (tz + zz * from) * s;
    const bz = (tz + zz * to) * s;
    d[o] = (tx + zx * from) * s;
    d[o + 1] = (ty + zy * from) * s;
    d[o + 2] = az;
    d[o + 3] = (tx + zx * to) * s;
    d[o + 4] = (ty + zy * to) * s;
    d[o + 5] = bz;
    d[o + 6] = r;
    this.#writeColor(d, o + 7, css);
    this.#extent(az, r);
    this.#extent(bz, r);
  }

  // ----- фигуры с путём ----- //

  #shape(shape: Shape, bucket: Bucket): void {
    const style = shape.style;
    const m = nodeView;
    // Обратная сторона, как в Zdog: только если точка `front` строго дальше начала.
    const f = shape.front;
    const originZ = m[11] as number;
    const frontZ =
      (m[2] as number) * f.x + (m[5] as number) * f.y + (m[8] as number) * f.z + originZ;
    const facingBack = frontZ < originZ;
    if (facingBack && !style.backfaceVisible) return;
    const css = facingBack ? (style.backfaceColor ?? style.color) : style.color;

    // Крышки и грани залитых объёмных фигур — сплошные плоскости полного размера
    // с учётом обводки. Трубка-обводка по краю почти совпала бы по глубине с боком
    // цилиндра или с трубкой соседней грани, и они спорили бы за пиксели.
    const owner = shape.owner;
    if (
      style.fill &&
      shape instanceof Ellipse &&
      (owner instanceof Cylinder || owner instanceof Cone || owner instanceof Hemisphere)
    ) {
      this.#cap(shape, bucket, css);
      return;
    }
    if (style.fill && shape instanceof Rect && owner instanceof Box) {
      this.#boxFace(shape, owner, bucket, css);
      return;
    }

    const s = this.#s;
    const world = shape.worldMatrix;
    const wx0 = world[0] as number;
    const wx1 = world[1] as number;
    const wx2 = world[2] as number;
    const wy0 = world[3] as number;
    const wy1 = world[4] as number;
    const wy2 = world[5] as number;
    const nodeScale = Math.sqrt(
      Math.sqrt(wx0 * wx0 + wx1 * wx1 + wx2 * wx2) * Math.sqrt(wy0 * wy0 + wy1 * wy1 + wy2 * wy2),
    );
    this.#radius = (style.stroke * nodeScale * s) / 2;

    // Масштаб перспективы входит в матрицу: s · (V · W · p) = (s · V · W) · p.
    for (let k = 0; k < 12; k++) modelView[k] = (m[k] as number) * s;
    const { ops, points, opCount, closed } = shape.geometry;

    if (opCount === 1) {
      if (this.#radius <= 0) return;
      project(points, 0);
      this.#pushSphere(bucket, css);
      return;
    }

    const line = this.#line;
    line.clear();
    let fillDone = false;

    let index = 0;
    for (let op = 0; op < opCount; op++) {
      const code = ops[op];
      if (code === PathOp.cubic) {
        const last = line.length - 1;
        const x0 = line.xs[last] as number;
        const y0 = line.ys[last] as number;
        const z0 = line.zs[last] as number;
        const c1 = project(points, index);
        const c1x = c1.x;
        const c1y = c1.y;
        const c1z = c1.z;
        const c2 = project(points, index + 1);
        const c2x = c2.x;
        const c2y = c2.y;
        const c2z = c2.z;
        const e = project(points, index + 2);
        const ex = e.x;
        const ey = e.y;
        const ez = e.z;
        // Число отрезков — по длине опорной ломаной на экране, примерно по 3 пикселя.
        const d1x = c1x - x0;
        const d1y = c1y - y0;
        const d2x = c2x - c1x;
        const d2y = c2y - c1y;
        const d3x = ex - c2x;
        const d3y = ey - c2y;
        const chord =
          Math.sqrt(d1x * d1x + d1y * d1y) +
          Math.sqrt(d2x * d2x + d2y * d2y) +
          Math.sqrt(d3x * d3x + d3y * d3y);
        const steps = Math.min(48, Math.max(2, Math.ceil(chord / 3)));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          const w0 = u * u * u;
          const w1 = 3 * u * u * t;
          const w2 = 3 * u * t * t;
          const w3 = t * t * t;
          const n = line.add();
          line.xs[n] = w0 * x0 + w1 * c1x + w2 * c2x + w3 * ex;
          line.ys[n] = w0 * y0 + w1 * c1y + w2 * c2y + w3 * ey;
          line.zs[n] = w0 * z0 + w1 * c1z + w2 * c2z + w3 * ez;
        }
        index += 3;
      } else {
        if (code === PathOp.move && line.length > 0) {
          this.#contour(bucket, css, closed, style.fill && !fillDone);
          fillDone ||= style.fill;
        }
        const p = project(points, index);
        const n = line.add();
        line.xs[n] = p.x;
        line.ys[n] = p.y;
        line.zs[n] = p.z;
        index++;
      }
    }
    if (line.length > 0) {
      this.#contour(bucket, css, closed, style.fill && !fillDone);
    }
  }

  /**
   * Обводка текущей ломаной капсулами радиуса `#radius` и, если `fill`, заливка.
   * Заливается только первый контур, как у Canvas с одним контуром. Ломаная после
   * вызова пуста.
   */
  #contour(bucket: Bucket, css: string, closed: boolean, fill: boolean): void {
    const line = this.#line;
    const radius = this.#radius;
    if (closed && line.length > 2) {
      const n = line.add();
      line.xs[n] = line.xs[0] as number;
      line.ys[n] = line.ys[0] as number;
      line.zs[n] = line.zs[0] as number;
    }
    if (radius > 0 && line.length > 1) {
      const { xs, ys, zs } = line;
      const out = bucket.data.capsule;
      let o = out.reserve((line.length - 1) * STRIDE.capsule);
      const d = out.data;
      for (let i = 1; i < line.length; i++) {
        const az = zs[i - 1] as number;
        const bz = zs[i] as number;
        d[o] = xs[i - 1] as number;
        d[o + 1] = ys[i - 1] as number;
        d[o + 2] = az;
        d[o + 3] = xs[i] as number;
        d[o + 4] = ys[i] as number;
        d[o + 5] = bz;
        d[o + 6] = radius;
        this.#writeColor(d, o + 7, css);
        o += STRIDE.capsule;
        if (az - radius < this.#zMin) this.#zMin = az - radius;
        if (az + radius > this.#zMax) this.#zMax = az + radius;
        if (bz - radius < this.#zMin) this.#zMin = bz - radius;
        if (bz + radius > this.#zMax) this.#zMax = bz + radius;
      }
    }
    if (fill) this.#fill(bucket, css, closed && line.length > 2 ? line.length - 1 : line.length);
    line.clear();
  }

  /** Крышка цилиндра, конуса или полусферы: диск радиусом основания плюс полтолщины обводки. */
  #cap(base: Ellipse, bucket: Bucket, css: string): void {
    const m = nodeView;
    const s = this.#s;
    const rx = base.width / 2 + base.style.stroke / 2;
    const ry = base.height / 2 + base.style.stroke / 2;
    const xx = m[0] as number;
    const xy = m[1] as number;
    const xz = m[2] as number;
    const yx = m[3] as number;
    const yy = m[4] as number;
    const yz = m[5] as number;
    const tx = m[9] as number;
    const ty = m[10] as number;
    const tz = m[11] as number;
    const line = this.#line;
    line.clear();
    // Число точек — по размеру на экране, примерно по 3 пикселя дуги.
    const k = Math.sqrt(xx * xx + xy * xy + xz * xz) * s;
    const steps = Math.min(128, Math.max(16, Math.ceil((2 * Math.PI * Math.max(rx, ry) * k) / 3)));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const cx = Math.cos(angle) * rx;
      const cy = Math.sin(angle) * ry;
      const n = line.add();
      line.xs[n] = (xx * cx + yx * cy + tx) * s;
      line.ys[n] = (xy * cx + yy * cy + ty) * s;
      line.zs[n] = (xz * cx + yz * cy + tz) * s;
    }
    this.#fill(bucket, css, steps);
  }

  /**
   * Грань залитой коробки: коробка раздута на полтолщины обводки во все стороны,
   * грани плоские и сходятся точно по рёбрам.
   */
  #boxFace(face: Rect, box: Box, bucket: Bucket, css: string): void {
    const s = this.#s;
    const pad = box.style.stroke / 2;
    // Углы считаются в координатах коробки, поэтому нужна её матрица, а не грани.
    mat3x4.multiply(boxView, (this.#camera as Camera).viewMatrix, box.worldMatrix);
    const line = this.#line;
    line.clear();
    const local = face.localMatrix;
    for (let i = 0; i < CORNERS.length; i++) {
      const c = CORNERS[i] as readonly [number, number];
      corner.x = (c[0] * face.width) / 2;
      corner.y = (c[1] * face.height) / 2;
      corner.z = 0;
      // Угол в координатах коробки: каждая координата — ±половина размера, раздуваем её.
      mat3x4.transformPoint(corner, local, corner);
      corner.x += Math.sign(corner.x) * pad;
      corner.y += Math.sign(corner.y) * pad;
      corner.z += Math.sign(corner.z) * pad;
      const p = mat3x4.transformPoint(scratch, boxView, corner);
      const n = line.add();
      line.xs[n] = p.x * s;
      line.ys[n] = p.y * s;
      line.zs[n] = p.z * s;
    }
    this.#fill(bucket, css, 4);
  }

  /** Заливка первых `n` точек текущей ломаной треугольниками. */
  #fill(bucket: Bucket, css: string, n: number): void {
    const triangles = this.#triangles;
    const line = this.#line;
    triangulate(line.xs, line.ys, n, triangles);
    const out = bucket.data.fill;
    const indices = triangles.data;
    let o = out.reserve(triangles.length * STRIDE.fill);
    const d = out.data;
    for (let k = 0; k < triangles.length; k++) {
      const i = indices[k] as number;
      const z = line.zs[i] as number;
      d[o] = line.xs[i] as number;
      d[o + 1] = line.ys[i] as number;
      d[o + 2] = z;
      this.#writeColor(d, o + 3, css);
      o += STRIDE.fill;
      if (z < this.#zMin) this.#zMin = z;
      if (z > this.#zMax) this.#zMax = z;
    }
  }

  // ----- поверхности ----- //

  /** Длина локальной оси x (`axis` 0) или z (`axis` 6) узла в пространстве камеры. */
  #axisLength(axis: 0 | 6): void {
    const m = nodeView;
    const x = m[axis] as number;
    const y = m[axis + 1] as number;
    const z = m[axis + 2] as number;
    this.#axis = Math.sqrt(x * x + y * y + z * z);
  }

  #sphere(sphere: Sphere, bucket: Bucket): void {
    const m = nodeView;
    const s = this.#s;
    this.#axisLength(0);
    this.#radius = ((sphere.diameter + sphere.style.stroke) / 2) * this.#axis * s;
    scratch.x = (m[9] as number) * s;
    scratch.y = (m[10] as number) * s;
    scratch.z = (m[11] as number) * s;
    this.#pushSphere(bucket, sphere.style.color);
  }

  #capsule(capsule: Capsule, bucket: Bucket): void {
    this.#axisLength(0);
    const half = capsule.length / 2;
    this.#radius = ((capsule.diameter + capsule.style.stroke) / 2) * this.#axis * this.#s;
    this.#pushAxisSegment(bucket.data.capsule, -half, half, capsule.style.color);
  }

  #dome(dome: HemisphereDome, bucket: Bucket): void {
    const m = nodeView;
    const s = this.#s;
    this.#axisLength(6);
    const axis = this.#axis || 1;
    const out = bucket.data.hemisphere;
    const o = out.reserve(STRIDE.hemisphere);
    const d = out.data;
    const r = ((dome.diameter + dome.style.stroke) / 2) * this.#axis * s;
    const cz = (m[11] as number) * s;
    d[o] = (m[9] as number) * s;
    d[o + 1] = (m[10] as number) * s;
    d[o + 2] = cz;
    d[o + 3] = r;
    d[o + 4] = (m[6] as number) / axis;
    d[o + 5] = (m[7] as number) / axis;
    d[o + 6] = (m[8] as number) / axis;
    this.#writeColor(d, o + 7, dome.style.color);
    this.#extent(cz, r);
  }

  #cylinderBody(body: CylinderBody, bucket: Bucket): void {
    this.#axisLength(6);
    const half = body.length / 2;
    this.#radius = ((body.diameter + body.style.stroke) / 2) * this.#axis * this.#s;
    this.#pushAxisSegment(bucket.data.cylinder, half, -half, body.style.color);
  }

  #coneSurface(surface: ConeSurface, bucket: Bucket): void {
    const m = nodeView;
    const s = this.#s;
    this.#axisLength(6);
    const length = surface.length;
    const out = bucket.data.cone;
    const o = out.reserve(STRIDE.cone);
    const d = out.data;
    const r = ((surface.diameter + surface.style.stroke) / 2) * this.#axis * s;
    const cz = (m[11] as number) * s;
    const apexZ = ((m[11] as number) + (m[8] as number) * length) * s;
    d[o] = (m[9] as number) * s;
    d[o + 1] = (m[10] as number) * s;
    d[o + 2] = cz;
    d[o + 3] = ((m[9] as number) + (m[6] as number) * length) * s;
    d[o + 4] = ((m[10] as number) + (m[7] as number) * length) * s;
    d[o + 5] = apexZ;
    d[o + 6] = r;
    this.#writeColor(d, o + 7, surface.style.color);
    this.#extent(cz, r);
    this.#extent(apexZ, 0);
  }
}

/** Точка `index` геометрии через `modelView` (с масштабом перспективы) в экранное 3D. */
function project(points: Float64Array, index: number): Vec3 {
  const i = index * 3;
  local.x = points[i] ?? 0;
  local.y = points[i + 1] ?? 0;
  local.z = points[i + 2] ?? 0;
  return mat3x4.transformPoint(scratch, modelView, local);
}
