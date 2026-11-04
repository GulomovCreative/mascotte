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
import { FloatBuffer } from './buffer.ts';
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
  readonly opaque: Bucket[] = [];
  readonly decals: Bucket[] = [];
  readonly transparent: Bucket[] = [];
  anchors = 0;

  clear(): void {
    this.opaque.length = 0;
    this.decals.length = 0;
    this.transparent.length = 0;
    this.anchors = 0;
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
  readonly #layers: Layer[] = [];
  readonly #anchors = new Map<Node, number>();
  #zMin = 0;
  #zMax = 0;
  #warnedAnchors = false;
  readonly #frame: { layers: Layer[]; zMin: number; zMax: number } = {
    layers: this.#layers,
    zMin: 0,
    zMax: 0,
  };
  // Ломаная текущего контура в экранном 3D.
  readonly #xs: number[] = [];
  readonly #ys: number[] = [];
  readonly #zs: number[] = [];
  readonly #triangles: number[] = [];

  collect(scene: Scene, camera: Camera): GLFrame {
    this.#used = 0;
    this.#layers.length = 0;
    this.#anchors.clear();
    this.#zMin = Number.POSITIVE_INFINITY;
    this.#zMax = Number.NEGATIVE_INFINITY;

    const drawables = this.#sorter.sort(scene, camera);
    const runs = this.#sorter.runs;
    // Номера опор: у каждой непрозрачной опоры декалей свой номер трафарета в её слое.
    // У полупрозрачной опоры номера нет: её декали тоже полупрозрачны (прозрачность
    // наследуется) и рисуются как обычные полупрозрачные фигуры.
    for (let i = 0; i < drawables.length; i++) {
      const anchor = decalAnchor(drawables[i] as Drawable);
      if (!anchor || this.#anchors.has(anchor) || anchor.worldOpacity < 1) continue;
      const layer = this.#layer(runs[i] ?? 0);
      if (layer.anchors < MAX_ANCHORS) this.#anchors.set(anchor, ++layer.anchors);
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
      const anchorId = anchor ? this.#anchors.get(anchor) : undefined;
      let bucket: Bucket;
      if (anchorId !== undefined) {
        // Декали рисуются без проверки глубины, строго по порядку сортировки, поэтому у
        // каждой своя корзина: внутри корзины примитивы идут по видам, а не по порядку.
        bucket = this.#bucket(layer.decals, anchorId, true, opacity < 1);
      } else if (opacity < 1) {
        bucket = this.#bucket(layer.transparent, 0, false, true);
      } else {
        const own =
          this.#anchors.get(drawable) ??
          (drawable.owner ? this.#anchors.get(drawable.owner) : undefined);
        bucket = this.#opaque(layer, own ?? 0);
      }
      this.#emit(drawable, camera, bucket, opacity);
    }
    if (this.#zMin > this.#zMax) {
      this.#zMin = -1;
      this.#zMax = 1;
    }
    const frame = this.#frame;
    frame.zMin = this.#zMin;
    frame.zMax = this.#zMax;
    return frame;
  }

  /** Слой с номером прогона `run`; слои создаются по порядку, пропусков нет. */
  #layer(run: number): Layer {
    while (this.#layers.length <= run) {
      let layer = this.#layerPool[this.#layers.length];
      if (!layer) {
        layer = new Layer();
        this.#layerPool.push(layer);
      }
      layer.clear();
      this.#layers.push(layer);
      // Обычная корзина слоя идёт первой.
      this.#bucket(layer.opaque, 0, false, false);
    }
    return this.#layers[run] as Layer;
  }

  #bucket(list: Bucket[], stencil: number, decal: boolean, blend: boolean): Bucket {
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
    for (const bucket of layer.opaque) if (bucket.stencil === stencil) return bucket;
    return this.#bucket(layer.opaque, stencil, false, false);
  }

  #extent(z: number, r: number): void {
    if (z - r < this.#zMin) this.#zMin = z - r;
    if (z + r > this.#zMax) this.#zMax = z + r;
  }

  /** Переводит локальную точку узла в экранное 3D (`scratch`). */
  #screen(node: Node, camera: Camera, s: number, x: number, y: number, z: number): Vec3 {
    local.x = x;
    local.y = y;
    local.z = z;
    node.localToWorld(scratch, local);
    camera.toView(scratch, scratch);
    scratch.x *= s;
    scratch.y *= s;
    scratch.z *= s;
    return scratch;
  }

  /** Масштаб перспективы по опорному узлу или `null`, если тот за глазом камеры. */
  #scale(drawable: Drawable, camera: Camera): number | null {
    camera.toView(scratch, drawable.perspectiveReference.getWorldPosition(scratch));
    return camera.isInFront(scratch.z) ? camera.scaleAt(scratch.z) : null;
  }

  /** Длина локальной оси узла в пространстве камеры: масштаб узла по этой оси. */
  #axisScale(node: Node, camera: Camera, x: number, y: number, z: number): number {
    const o = this.#screen(node, camera, 1, 0, 0, 0);
    const ox = o.x;
    const oy = o.y;
    const oz = o.z;
    const a = this.#screen(node, camera, 1, x, y, z);
    return Math.hypot(a.x - ox, a.y - oy, a.z - oz);
  }

  #emit(drawable: Drawable, camera: Camera, bucket: Bucket, opacity: number): void {
    const s = this.#scale(drawable, camera);
    if (s === null) return;
    if (drawable instanceof Shape) this.#shape(drawable, camera, s, bucket, opacity);
    else if (drawable instanceof Sphere) this.#sphere(drawable, camera, s, bucket, opacity);
    else if (drawable instanceof Capsule) this.#capsule(drawable, camera, s, bucket, opacity);
    else if (drawable instanceof HemisphereDome) this.#dome(drawable, camera, s, bucket, opacity);
    else if (drawable instanceof CylinderBody)
      this.#cylinderBody(drawable, camera, s, bucket, opacity);
    else if (drawable instanceof ConeSurface)
      this.#coneSurface(drawable, camera, s, bucket, opacity);
  }

  #color(buffer: FloatBuffer, css: string, opacity: number): void {
    const [r, g, b, a] = rgba(css);
    buffer.push(r);
    buffer.push(g);
    buffer.push(b);
    buffer.push(a * opacity);
  }

  #pushSphere(
    bucket: Bucket,
    x: number,
    y: number,
    z: number,
    r: number,
    css: string,
    opacity: number,
  ): void {
    const out = bucket.data.sphere;
    out.push(x);
    out.push(y);
    out.push(z);
    out.push(r);
    this.#color(out, css, opacity);
    this.#extent(z, r);
  }

  #pushSegment(
    kind: 'capsule' | 'cylinder',
    bucket: Bucket,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    r: number,
    css: string,
    opacity: number,
  ): void {
    const out = bucket.data[kind];
    out.push(ax);
    out.push(ay);
    out.push(az);
    out.push(bx);
    out.push(by);
    out.push(bz);
    out.push(r);
    this.#color(out, css, opacity);
    this.#extent(az, r);
    this.#extent(bz, r);
  }

  // ----- фигуры с путём ----- //

  #shape(shape: Shape, camera: Camera, s: number, bucket: Bucket, opacity: number): void {
    const style = shape.style;
    // Обратная сторона, как в Zdog: только если точка `front` строго дальше начала.
    const origin = this.#screen(shape, camera, 1, 0, 0, 0).z;
    const front = this.#screen(shape, camera, 1, shape.front.x, shape.front.y, shape.front.z).z;
    const facingBack = front < origin;
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
      this.#cap(shape, camera, s, bucket, css, opacity);
      return;
    }
    if (style.fill && shape instanceof Rect && owner instanceof Box) {
      this.#boxFace(shape, owner, camera, s, bucket, css, opacity);
      return;
    }

    const world = shape.worldMatrix;
    const nodeScale = Math.sqrt(
      Math.hypot(world[0] ?? 0, world[1] ?? 0, world[2] ?? 0) *
        Math.hypot(world[3] ?? 0, world[4] ?? 0, world[5] ?? 0),
    );
    const radius = (style.stroke * nodeScale * s) / 2;

    mat3x4.multiply(modelView, camera.viewMatrix, world);
    const { ops, points, opCount, closed } = shape.geometry;

    if (opCount === 1) {
      if (radius <= 0) return;
      const p = project(points, 0, s);
      this.#pushSphere(bucket, p.x, p.y, p.z, radius, css, opacity);
      return;
    }

    const xs = this.#xs;
    const ys = this.#ys;
    const zs = this.#zs;
    xs.length = 0;
    ys.length = 0;
    zs.length = 0;
    let fillDone = false;

    let index = 0;
    for (let op = 0; op < opCount; op++) {
      const code = ops[op];
      if (code === PathOp.cubic) {
        const x0 = xs.at(-1) as number;
        const y0 = ys.at(-1) as number;
        const z0 = zs.at(-1) as number;
        const c1 = project(points, index, s);
        const c1x = c1.x;
        const c1y = c1.y;
        const c1z = c1.z;
        const c2 = project(points, index + 1, s);
        const c2x = c2.x;
        const c2y = c2.y;
        const c2z = c2.z;
        const e = project(points, index + 2, s);
        const ex = e.x;
        const ey = e.y;
        const ez = e.z;
        // Число отрезков — по длине опорной ломаной на экране, примерно по 3 пикселя.
        const chord =
          Math.hypot(c1x - x0, c1y - y0) +
          Math.hypot(c2x - c1x, c2y - c1y) +
          Math.hypot(ex - c2x, ey - c2y);
        const steps = Math.min(48, Math.max(2, Math.ceil(chord / 3)));
        for (let k = 1; k <= steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          const w0 = u * u * u;
          const w1 = 3 * u * u * t;
          const w2 = 3 * u * t * t;
          const w3 = t * t * t;
          xs.push(w0 * x0 + w1 * c1x + w2 * c2x + w3 * ex);
          ys.push(w0 * y0 + w1 * c1y + w2 * c2y + w3 * ey);
          zs.push(w0 * z0 + w1 * c1z + w2 * c2z + w3 * ez);
        }
        index += 3;
      } else {
        if (code === PathOp.move && xs.length > 0) {
          this.#contour(bucket, css, opacity, radius, closed, style.fill && !fillDone);
          fillDone ||= style.fill;
        }
        const p = project(points, index, s);
        xs.push(p.x);
        ys.push(p.y);
        zs.push(p.z);
        index++;
      }
    }
    if (xs.length > 0) this.#contour(bucket, css, opacity, radius, closed, style.fill && !fillDone);
  }

  /**
   * Обводка текущей ломаной капсулами и, если `fill`, заливка. Заливается только первый
   * контур, как у Canvas с одним контуром. Ломаная после вызова пуста.
   */
  #contour(
    bucket: Bucket,
    css: string,
    opacity: number,
    radius: number,
    closed: boolean,
    fill: boolean,
  ): void {
    const xs = this.#xs;
    const ys = this.#ys;
    const zs = this.#zs;
    if (closed && xs.length > 2) {
      xs.push(xs[0] as number);
      ys.push(ys[0] as number);
      zs.push(zs[0] as number);
    }
    if (radius > 0) {
      for (let i = 1; i < xs.length; i++) {
        this.#pushSegment(
          'capsule',
          bucket,
          xs[i - 1] as number,
          ys[i - 1] as number,
          zs[i - 1] as number,
          xs[i] as number,
          ys[i] as number,
          zs[i] as number,
          radius,
          css,
          opacity,
        );
      }
    }
    if (fill) this.#fill(bucket, css, opacity, closed && xs.length > 2 ? xs.length - 1 : xs.length);
    xs.length = 0;
    ys.length = 0;
    zs.length = 0;
  }

  /** Крышка цилиндра, конуса или полусферы: диск радиусом основания плюс полтолщины обводки. */
  #cap(
    base: Ellipse,
    camera: Camera,
    s: number,
    bucket: Bucket,
    css: string,
    opacity: number,
  ): void {
    const rx = base.width / 2 + base.style.stroke / 2;
    const ry = base.height / 2 + base.style.stroke / 2;
    const xs = this.#xs;
    const ys = this.#ys;
    const zs = this.#zs;
    xs.length = 0;
    ys.length = 0;
    zs.length = 0;
    // Число точек — по размеру на экране, примерно по 3 пикселя дуги.
    const k = this.#axisScale(base, camera, 1, 0, 0) * s;
    const steps = Math.min(128, Math.max(16, Math.ceil((2 * Math.PI * Math.max(rx, ry) * k) / 3)));
    for (let i = 0; i < steps; i++) {
      const angle = (i / steps) * Math.PI * 2;
      const p = this.#screen(base, camera, s, Math.cos(angle) * rx, Math.sin(angle) * ry, 0);
      xs.push(p.x);
      ys.push(p.y);
      zs.push(p.z);
    }
    this.#fill(bucket, css, opacity, steps);
  }

  /**
   * Грань залитой коробки: коробка раздута на полтолщины обводки во все стороны,
   * грани плоские и сходятся точно по рёбрам.
   */
  #boxFace(
    face: Rect,
    box: Box,
    camera: Camera,
    s: number,
    bucket: Bucket,
    css: string,
    opacity: number,
  ): void {
    const pad = box.style.stroke / 2;
    const xs = this.#xs;
    const ys = this.#ys;
    const zs = this.#zs;
    xs.length = 0;
    ys.length = 0;
    zs.length = 0;
    const local = face.localMatrix;
    for (const [cx, cy] of CORNERS) {
      corner.x = (cx * face.width) / 2;
      corner.y = (cy * face.height) / 2;
      corner.z = 0;
      // Угол в координатах коробки: каждая координата — ±половина размера, раздуваем её.
      mat3x4.transformPoint(corner, local, corner);
      const p = this.#screen(
        box,
        camera,
        s,
        corner.x + Math.sign(corner.x) * pad,
        corner.y + Math.sign(corner.y) * pad,
        corner.z + Math.sign(corner.z) * pad,
      );
      xs.push(p.x);
      ys.push(p.y);
      zs.push(p.z);
    }
    this.#fill(bucket, css, opacity, 4);
  }

  /** Заливка первых `n` точек текущей ломаной треугольниками. */
  #fill(bucket: Bucket, css: string, opacity: number, n: number): void {
    const triangles = this.#triangles;
    triangulate(this.#xs, this.#ys, n, triangles);
    const out = bucket.data.fill;
    for (const i of triangles) {
      out.push(this.#xs[i] as number);
      out.push(this.#ys[i] as number);
      const z = this.#zs[i] as number;
      out.push(z);
      this.#color(out, css, opacity);
      this.#extent(z, 0);
    }
  }

  // ----- поверхности ----- //

  #sphere(sphere: Sphere, camera: Camera, s: number, bucket: Bucket, opacity: number): void {
    const k = this.#axisScale(sphere, camera, 1, 0, 0);
    const c = this.#screen(sphere, camera, s, 0, 0, 0);
    const r = ((sphere.diameter + sphere.style.stroke) / 2) * k * s;
    this.#pushSphere(bucket, c.x, c.y, c.z, r, sphere.style.color, opacity);
  }

  #capsule(capsule: Capsule, camera: Camera, s: number, bucket: Bucket, opacity: number): void {
    const k = this.#axisScale(capsule, camera, 1, 0, 0);
    const half = capsule.length / 2;
    const a = this.#screen(capsule, camera, s, 0, 0, -half);
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const b = this.#screen(capsule, camera, s, 0, 0, half);
    const r = ((capsule.diameter + capsule.style.stroke) / 2) * k * s;
    this.#pushSegment(
      'capsule',
      bucket,
      ax,
      ay,
      az,
      b.x,
      b.y,
      b.z,
      r,
      capsule.style.color,
      opacity,
    );
  }

  #dome(dome: HemisphereDome, camera: Camera, s: number, bucket: Bucket, opacity: number): void {
    const k = this.#axisScale(dome, camera, 0, 0, 1);
    const c = this.#screen(dome, camera, s, 0, 0, 0);
    const cx = c.x;
    const cy = c.y;
    const cz = c.z;
    const tip = this.#screen(dome, camera, s, 0, 0, 1);
    const length = Math.hypot(tip.x - cx, tip.y - cy, tip.z - cz) || 1;
    const out = bucket.data.hemisphere;
    const r = ((dome.diameter + dome.style.stroke) / 2) * k * s;
    out.push(cx);
    out.push(cy);
    out.push(cz);
    out.push(r);
    out.push((tip.x - cx) / length);
    out.push((tip.y - cy) / length);
    out.push((tip.z - cz) / length);
    this.#color(out, dome.style.color, opacity);
    this.#extent(cz, r);
  }

  #cylinderBody(
    body: CylinderBody,
    camera: Camera,
    s: number,
    bucket: Bucket,
    opacity: number,
  ): void {
    const k = this.#axisScale(body, camera, 0, 0, 1);
    const half = body.length / 2;
    const a = this.#screen(body, camera, s, 0, 0, half);
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const b = this.#screen(body, camera, s, 0, 0, -half);
    const r = ((body.diameter + body.style.stroke) / 2) * k * s;
    this.#pushSegment('cylinder', bucket, ax, ay, az, b.x, b.y, b.z, r, body.style.color, opacity);
  }

  #coneSurface(
    surface: ConeSurface,
    camera: Camera,
    s: number,
    bucket: Bucket,
    opacity: number,
  ): void {
    const k = this.#axisScale(surface, camera, 0, 0, 1);
    const c = this.#screen(surface, camera, s, 0, 0, 0);
    const cx = c.x;
    const cy = c.y;
    const cz = c.z;
    const apex = this.#screen(surface, camera, s, 0, 0, surface.length);
    const r = ((surface.diameter + surface.style.stroke) / 2) * k * s;
    const out = bucket.data.cone;
    out.push(cx);
    out.push(cy);
    out.push(cz);
    out.push(apex.x);
    out.push(apex.y);
    out.push(apex.z);
    out.push(r);
    this.#color(out, surface.style.color, opacity);
    this.#extent(cz, r);
    this.#extent(apex.z, 0);
  }
}

/** Точка `index` геометрии через `modelView` в экранное 3D. */
function project(points: Float64Array, index: number, s: number): Vec3 {
  const i = index * 3;
  local.x = points[i] ?? 0;
  local.y = points[i + 1] ?? 0;
  local.z = points[i + 2] ?? 0;
  mat3x4.transformPoint(scratch, modelView, local);
  scratch.x *= s;
  scratch.y *= s;
  scratch.z *= s;
  return scratch;
}
