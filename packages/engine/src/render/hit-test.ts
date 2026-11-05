import type { Camera } from '../scene/camera.ts';
import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { DepthSorter, type Drawable } from './depth-sort.ts';
import { Bucket, decalAnchor, GLCollector, MAX_ANCHORS, STRIDE } from './gl/collect.ts';

/*
 * Проверка попадания: какая фигура видна в точке кадра. Фигуры раскладываются на те же
 * примитивы в экранном 3D, что и для WebGL2, и в точке считается пересечение луча
 * взгляда с каждым — теми же формулами, что в шейдерах. Правила видимости тоже те же:
 * - верхний слой сортировки закрывает нижние;
 * - внутри слоя видна ближняя фигура, при равной глубине — раньше в порядке сортировки;
 * - декаль видна только там, где видна её непрозрачная опора, и тогда закрывает её;
 *   из нескольких декалей видна нарисованная последней;
 * - у полупрозрачной опоры и сверх `MAX_ANCHORS` опор в слое декали — обычные фигуры;
 * - скрытые, полностью прозрачные и обращённые обратной стороной без `backfaceVisible`
 *   фигуры не попадают.
 *
 * Расхождения с кадром возможны только у точно совпадающих поверхностей: WebGL2 при
 * равной глубине оставляет нарисованное раньше, а рисует он корзинами и по видам
 * примитивов, а не строго в порядке сортировки.
 *
 * Проверка идёт по пикселям, как в WebGL2, а не по порядку списка отрисовки. Canvas 2D
 * рисует перекрытия по порядку, поэтому у краёв перекрывающихся фигур его картинка
 * может немного расходиться с результатом.
 */

/** Результат проверки попадания. */
export interface Hit {
  /** Рисуемый узел в точке. */
  readonly drawable: Drawable;
  /** Узел для выбора: составная фигура для её частей, иначе сам рисуемый узел. */
  readonly node: Node;
  /**
   * Глубина точки фигуры в экранном 3D (больше — ближе к зрителю). У декали — её
   * собственная глубина: она может лежать чуть глубже видимой поверхности опоры.
   */
  readonly depth: number;
}

/** Размеры кадра в пикселях CSS. */
export interface HitViewport {
  readonly width: number;
  readonly height: number;
}

interface Candidate {
  drawable: Drawable | null;
  depth: number;
}

/**
 * Проверка попадания по сцене. Сортировщик, сборщик, буфер примитивов и записи декалей
 * переиспользуются между вызовами; на вызов создаётся только результат. Стоит она
 * примерно как сборка кадра для WebGL2.
 */
export class HitTester {
  readonly #sorter = new DepthSorter();
  readonly #collector = new GLCollector();
  readonly #bucket = new Bucket();
  // Лучшее в текущем слое: ближайшая обычная фигура и последняя декаль на каждой опоре.
  readonly #nearest: Candidate = { drawable: null, depth: 0 };
  readonly #decals = new Map<Node, Candidate>();
  readonly #candidates: Candidate[] = [];
  #usedCandidates = 0;
  // Опоры с номером в трафарете в текущем слое — так же, как у сборщика кадра.
  readonly #anchors = new Set<Node>();

  /**
   * Фигура, видимая в точке (`x`, `y`) кадра: пиксели CSS от левого верхнего угла,
   * как у `offsetX`/`offsetY` события указателя. `null`, если там ничего нет.
   */
  hitTest(scene: Scene, camera: Camera, viewport: HitViewport, x: number, y: number): Hit | null {
    const px = x - viewport.width / 2;
    const py = y - viewport.height / 2;
    const drawables = this.#sorter.sort(scene, camera);
    const runs = this.#sorter.runs;
    let result: Hit | null = null;
    let run = -1;
    this.#resetLayer();
    for (let i = 0; i < drawables.length; i++) {
      const drawable = drawables[i] as Drawable;
      if ((runs[i] ?? 0) !== run) {
        result = this.#finishLayer() ?? result;
        run = runs[i] ?? 0;
      }
      // Номер опоры раздаётся до всех пропусков, как у сборщика кадра.
      const decal = this.#isDecalOf(drawable);
      if (drawable.worldOpacity <= 0) continue;
      const bucket = this.#bucket;
      bucket.reset();
      this.#collector.emitDrawable(drawable, camera, bucket);
      const depth = nearestDepth(bucket, px, py);
      if (depth === null) continue;
      if (decal) {
        // Декали рисуются по порядку поверх опоры: видна последняя.
        const anchor = decalAnchor(drawable) as Node;
        let candidate = this.#decals.get(anchor);
        if (!candidate) {
          candidate = this.#candidate();
          this.#decals.set(anchor, candidate);
        }
        candidate.drawable = drawable;
        candidate.depth = depth;
      } else if (this.#nearest.drawable === null || depth > this.#nearest.depth) {
        this.#nearest.drawable = drawable;
        this.#nearest.depth = depth;
      }
    }
    return this.#finishLayer() ?? result;
  }

  /**
   * Декаль ли фигура для трафарета: у опоры есть номер. Номера раздаются в порядке
   * сортировки при первой декали опоры, как в `GLCollector.collect`, поэтому проверку
   * проходят все фигуры слоя, а не только попавшие в точку.
   */
  #isDecalOf(drawable: Drawable): boolean {
    const anchor = decalAnchor(drawable);
    if (!anchor || anchor.worldOpacity < 1) return false;
    const anchors = this.#anchors;
    if (!anchors.has(anchor) && anchors.size < MAX_ANCHORS) anchors.add(anchor);
    return anchors.has(anchor);
  }

  #candidate(): Candidate {
    let candidate = this.#candidates[this.#usedCandidates];
    if (!candidate) {
      candidate = { drawable: null, depth: 0 };
      this.#candidates.push(candidate);
    }
    this.#usedCandidates++;
    return candidate;
  }

  #resetLayer(): void {
    this.#nearest.drawable = null;
    this.#decals.clear();
    this.#anchors.clear();
    this.#usedCandidates = 0;
  }

  /** Видимое в точке по итогам слоя или `null`; готовит следующий слой. */
  #finishLayer(): Hit | null {
    const nearest = this.#nearest.drawable;
    let hit: Hit | null = null;
    if (nearest) {
      // Декаль видна, если в точке видна её опора: сама фигура или часть составной.
      const decal = this.#decals.get(nearest) ?? (nearest.owner && this.#decals.get(nearest.owner));
      const drawable = decal ? (decal.drawable as Drawable) : nearest;
      hit = {
        drawable,
        node: drawable.owner ?? drawable,
        depth: decal ? decal.depth : this.#nearest.depth,
      };
    }
    this.#resetLayer();
    return hit;
  }
}

/** Ближайшая к зрителю глубина примитивов корзины в точке или `null`. */
function nearestDepth(bucket: Bucket, px: number, py: number): number | null {
  let best = Number.NEGATIVE_INFINITY;
  const sphere = bucket.data.sphere;
  for (let i = 0; i < sphere.length; i += STRIDE.sphere) {
    const d = sphere.data;
    best = Math.max(best, sphereDepth(px, py, at(d, i), at(d, i + 1), at(d, i + 2), at(d, i + 3)));
  }
  const capsule = bucket.data.capsule;
  for (let i = 0; i < capsule.length; i += STRIDE.capsule) {
    best = Math.max(best, capsuleDepth(px, py, capsule.data, i));
  }
  const cylinder = bucket.data.cylinder;
  for (let i = 0; i < cylinder.length; i += STRIDE.cylinder) {
    best = Math.max(best, cylinderDepth(px, py, cylinder.data, i));
  }
  const hemisphere = bucket.data.hemisphere;
  for (let i = 0; i < hemisphere.length; i += STRIDE.hemisphere) {
    best = Math.max(best, hemisphereDepth(px, py, hemisphere.data, i));
  }
  const cone = bucket.data.cone;
  for (let i = 0; i < cone.length; i += STRIDE.cone) {
    best = Math.max(best, coneDepth(px, py, cone.data, i));
  }
  const fill = bucket.data.fill;
  const step = STRIDE.fill;
  for (let i = 0; i + 3 * step <= fill.length; i += 3 * step) {
    best = Math.max(best, triangleDepth(px, py, fill.data, i, i + step, i + 2 * step));
  }
  return best === Number.NEGATIVE_INFINITY ? null : best;
}

const MISS = Number.NEGATIVE_INFINITY;

function at(data: Float32Array | Float64Array, i: number): number {
  return data[i] ?? 0;
}

function sphereDepth(px: number, py: number, cx: number, cy: number, cz: number, r: number) {
  const dx = px - cx;
  const dy = py - cy;
  const h = r * r - dx * dx - dy * dy;
  return h < 0 ? MISS : cz + Math.sqrt(h);
}

/*
 * Формулы ниже — пересечения луча из (px, py, +∞) вдоль −z, как в шейдерах. Луч
 * начинается чуть ближе самого примитива: z = rayZ, результат — глубина rayZ − t.
 */

function capsuleDepth(px: number, py: number, d: Float32Array | Float64Array, i: number) {
  const ax = at(d, i);
  const ay = at(d, i + 1);
  const az = at(d, i + 2);
  const bx = at(d, i + 3);
  const by = at(d, i + 4);
  const bz = at(d, i + 5);
  const r = at(d, i + 6);
  const rayZ = Math.max(az, bz) + r + 1;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const oax = px - ax;
  const oay = py - ay;
  const oaz = rayZ - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = -baz;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = -oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const a = baba - bard * bard;
  if (a > 1e-9 * Math.max(baba, 1e-9)) {
    const b = baba * rdoa - baoa * bard;
    const c = baba * oaoa - baoa * baoa - r * r * baba;
    const h = b * b - a * c;
    if (h < 0) return MISS;
    const t = (-b - Math.sqrt(h)) / a;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return rayZ - t;
    return y <= 0 ? sphereDepth(px, py, ax, ay, az, r) : sphereDepth(px, py, bx, by, bz, r);
  }
  // Отрезок вдоль луча: видна ближняя сфера-конец.
  return az > bz ? sphereDepth(px, py, ax, ay, az, r) : sphereDepth(px, py, bx, by, bz, r);
}

function cylinderDepth(px: number, py: number, d: Float32Array | Float64Array, i: number) {
  const ax = at(d, i);
  const ay = at(d, i + 1);
  const az = at(d, i + 2);
  const bx = at(d, i + 3);
  const by = at(d, i + 4);
  const bz = at(d, i + 5);
  const r = at(d, i + 6);
  const rayZ = Math.max(az, bz) + r + 1;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const ocx = px - ax;
  const ocy = py - ay;
  const ocz = rayZ - az;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = -baz;
  const baoc = bax * ocx + bay * ocy + baz * ocz;
  const k2 = baba - bard * bard;
  if (k2 < 1e-9 * Math.max(baba, 1e-9)) return MISS;
  const k1 = baba * -ocz - baoc * bard;
  const k0 = baba * (ocx * ocx + ocy * ocy + ocz * ocz) - baoc * baoc - r * r * baba;
  let h = k1 * k1 - k2 * k0;
  if (h < 0) return MISS;
  h = Math.sqrt(h);
  // Ближняя стенка, а если она за краем отрезка — дальняя (вид внутрь трубы).
  const near = (-k1 - h) / k2;
  const nearY = baoc + near * bard;
  if (nearY > 0 && nearY < baba) return rayZ - near;
  const far = (-k1 + h) / k2;
  const farY = baoc + far * bard;
  return farY > 0 && farY < baba ? rayZ - far : MISS;
}

function hemisphereDepth(px: number, py: number, d: Float32Array | Float64Array, i: number) {
  const cx = at(d, i);
  const cy = at(d, i + 1);
  const cz = at(d, i + 2);
  const r = at(d, i + 3);
  const ux = at(d, i + 4);
  const uy = at(d, i + 5);
  const uz = at(d, i + 6);
  const dx = px - cx;
  const dy = py - cy;
  const h = r * r - dx * dx - dy * dy;
  if (h < 0) return MISS;
  const s = Math.sqrt(h);
  // Ближняя точка сферы, если она на стороне купола, иначе дальняя (вид внутрь).
  const along = dx * ux + dy * uy;
  if (along + s * uz >= 0) return cz + s;
  if (along - s * uz >= 0) return cz - s;
  return MISS;
}

function coneDepth(px: number, py: number, d: Float32Array | Float64Array, i: number) {
  const ax = at(d, i);
  const ay = at(d, i + 1);
  const az = at(d, i + 2);
  const bx = at(d, i + 3);
  const by = at(d, i + 4);
  const bz = at(d, i + 5);
  const ra = at(d, i + 6);
  const rayZ = Math.max(az + ra, bz) + 1;
  const bax = bx - ax;
  const bay = by - ay;
  const baz = bz - az;
  const oax = px - ax;
  const oay = py - ay;
  const oaz = rayZ - az;
  const m0 = bax * bax + bay * bay + baz * baz;
  const m1 = oax * bax + oay * bay + oaz * baz;
  const m2 = -baz;
  const m3 = -oaz;
  const m5 = oax * oax + oay * oay + oaz * oaz;
  const hy = m0 + ra * ra;
  const k2 = m0 * m0 - m2 * m2 * hy;
  const k1 = m0 * m0 * m3 - m1 * m2 * hy + m0 * ra * (ra * m2);
  const k0 = m0 * m0 * m5 - m1 * m1 * hy + m0 * ra * (ra * m1 * 2 - m0 * ra);
  let h = k1 * k1 - k2 * k0;
  if (h < 0 || Math.abs(k2) < 1e-12) return MISS;
  h = Math.sqrt(h);
  const first = (-k1 - h) / k2;
  const firstY = m1 + first * m2;
  if (firstY > 0 && firstY < m0) return rayZ - first;
  const second = (-k1 + h) / k2;
  const secondY = m1 + second * m2;
  return secondY > 0 && secondY < m0 ? rayZ - second : MISS;
}

function triangleDepth(
  px: number,
  py: number,
  d: Float32Array | Float64Array,
  a: number,
  b: number,
  c: number,
) {
  const ax = at(d, a);
  const ay = at(d, a + 1);
  const bx = at(d, b);
  const by = at(d, b + 1);
  const cx = at(d, c);
  const cy = at(d, c + 1);
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (area === 0) return MISS;
  // Барицентрические координаты; знак площади учитывает любой обход.
  const u = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area;
  const v = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area;
  const w = 1 - u - v;
  if (u < 0 || v < 0 || w < 0) return MISS;
  return u * at(d, a + 2) + v * at(d, b + 2) + w * at(d, c + 2);
}
