import { mat3x4, TAU, type Vec3 } from '@mascotte/math';
import type { Camera } from '../scene/camera.ts';
import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { PathOp } from '../shapes/path.ts';
import { Shape } from '../shapes/shape.ts';
import { SurfaceOutline } from '../shapes/surface.ts';
import { DepthSorter, type Drawable, isDrawable } from './depth-sort.ts';
import { type Cutter, type SplitTarget, splitPath } from './occlusion.ts';

/**
 * Display list item: a path in pixels relative to the frame center, a brush and
 * opacity. The objects are reused between frames.
 */
export class DisplayItem extends SurfaceOutline {
  /** The node the item came from: for debugging and picking under the cursor. */
  node: Drawable | null = null;
  /** Final opacity including ancestors. */
  opacity = 1;
  /** @internal The item is cut; its parts are drawn instead. */
  split = false;
  /** @internal Parts of other strokes drawn before this occluder. */
  readonly behind: DisplayItem[] = [];
  /** @internal Parts of other strokes drawn after this occluder. */
  readonly inFront: DisplayItem[] = [];
}

export interface DisplayListOptions {
  /**
   * Whether to cut strokes with occluder planes (partial occlusion). Enabled
   * by default; disabled, for example, to compare the frame with Zdog.
   */
  partialOcclusion?: boolean;
}

const modelView = mat3x4.create();
const point: Vec3 = { x: 0, y: 0, z: 0 };
const front: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * The frame's display list: what to draw and in what order. Built from the scene and camera:
 * depth sorting, projection of shape paths, surface outlines, back faces,
 * opacity. The backend draws the finished list without knowing about the scene.
 *
 * Items and their buffers are reused between frames; new ones are created only when
 * there are more items than before.
 */
export class DisplayList {
  readonly #sorter = new DepthSorter();
  readonly #partialOcclusion: boolean;
  readonly #items: DisplayItem[] = [];
  #itemCount = 0;
  readonly #parts: DisplayItem[] = [];
  #partCount = 0;
  readonly #order: DisplayItem[] = [];
  readonly #queue: DisplayItem[] = [];

  constructor(options: DisplayListOptions = {}) {
    this.#partialOcclusion = options.partialOcclusion ?? true;
  }

  /** Number of items after the last build. */
  get count(): number {
    return this.#order.length;
  }

  /** Item `index` of the first `count` in drawing order. */
  item(index: number): DisplayItem {
    const item = this.#order[index];
    if (!item) throw new RangeError(`No item ${index}.`);
    return item;
  }

  build(scene: Scene, camera: Camera): this {
    this.#itemCount = 0;
    for (const drawable of this.#sorter.sort(scene, camera)) {
      const opacity = drawable.worldOpacity;
      if (opacity <= 0) continue;
      const item = nextItem(this.#items, this.#itemCount);
      item.resetOcclusion();
      const ready =
        drawable instanceof Shape
          ? projectShape(drawable, camera, item)
          : drawable.buildOutline(camera, item);
      if (!ready) continue;
      // Canvas does not accept a zero width and would keep the previous one: there is no such stroke.
      if (!(item.lineWidth > 0)) item.hasStroke = false;
      if (!(item.hasStroke || item.hasFill)) continue;
      item.node = drawable;
      item.opacity = opacity;
      this.#itemCount++;
    }
    this.#arrange();
    return this;
  }

  /** Arranges items in drawing order, taking partial occlusion into account. */
  #arrange(): void {
    const items = this.#items;
    const count = this.#itemCount;
    const order = this.#order;
    order.length = 0;
    this.#partCount = 0;
    for (let i = 0; i < count; i++) {
      const item = items[i] as DisplayItem;
      item.split = false;
      item.behind.length = 0;
      item.inFront.length = 0;
    }
    if (this.#partialOcclusion) {
      this.#clipDecals();
      this.#split();
    }
    for (let i = 0; i < count; i++) {
      const item = items[i] as DisplayItem;
      if (item.split) continue;
      for (const part of item.behind) order.push(part);
      order.push(item);
      for (const part of item.inFront) order.push(part);
    }
  }

  /** Decals on a sphere are clipped by its silhouette and not cut by it. */
  #clipDecals(): void {
    const items = this.#items;
    const count = this.#itemCount;
    for (let i = 0; i < count; i++) {
      const item = items[i] as DisplayItem;
      const anchor = this.#anchorItem(item);
      if (anchor?.occluder !== 'sphere') continue;
      item.clip = 'circle';
      item.clipX = anchor.occluderX;
      item.clipY = anchor.occluderY;
      item.clipRadius = anchor.occluderRadius;
    }
  }

  /** The item of the decal's anchor in this frame, or `null` if the item is not a decal. */
  #anchorItem(item: DisplayItem): DisplayItem | null {
    const node = item.node;
    if (!node) return null;
    const anchor = decalAnchor(node);
    if (!anchor) return null;
    const items = this.#items;
    for (let i = 0; i < this.#itemCount; i++) {
      const candidate = items[i] as DisplayItem;
      if (candidate.node === anchor) return candidate;
    }
    return null;
  }

  #split(): void {
    const items = this.#items;
    const count = this.#itemCount;
    // Capsules are cut first, from larger to smaller: a cut occluder is not used
    // afterwards, so no stroke parts get attached to it.
    const queue = this.#queue;
    queue.length = 0;
    for (let i = 0; i < count; i++) {
      const item = items[i] as DisplayItem;
      if (item.splittable && item.hasStroke && !item.hasFill) queue.push(item);
    }
    sortByRadius(queue);
    for (const shape of queue) {
      const index = items.indexOf(shape);
      bounds(shape);
      for (let j = 0; j < count; j++) {
        const occluder = items[j] as DisplayItem;
        if (j === index || occluder.occluder === 'none' || occluder.split) continue;
        // A decal lies on the surface of its anchor: the anchor does not cut it.
        if (occluder.node !== null && occluder.node === decalAnchor(shape.node)) continue;
        if (shape.occluder !== 'none' && !(occluder.occluderRadius > shape.occluderRadius))
          continue;
        if (!overlaps(occluder)) continue;
        setCutter(occluder, shape.lineWidth / 2);
        const mark = this.#partCount;
        const back = this.#part(shape);
        const front = this.#part(shape);
        target[0] = back.path;
        target[1] = front.path;
        splitPath(shape.path, cutter, target as unknown as SplitTarget);
        const hasBack = back.path.opCount > 0;
        const hasFront = front.path.opCount > 0;
        // A cut is needed if the stroke is on both sides of the occluder or entirely
        // on the wrong side in drawing order.
        const needed = (hasBack && hasFront) || (hasBack && index > j) || (hasFront && index < j);
        if (!needed) {
          this.#partCount = mark;
          continue;
        }
        if (hasBack) occluder.behind.push(back);
        if (hasFront) occluder.inFront.push(front);
        shape.split = true;
        break;
      }
    }
  }

  /** An empty part of the stroke of `shape` with its brush. */
  #part(shape: DisplayItem): DisplayItem {
    const part = nextItem(this.#parts, this.#partCount++);
    part.path.reset();
    part.resetOcclusion();
    part.node = shape.node;
    part.opacity = shape.opacity;
    part.lineWidth = shape.lineWidth;
    part.lineCap = shape.lineCap;
    part.hasStroke = true;
    part.hasFill = false;
    part.color = shape.color;
    part.clip = shape.clip;
    part.clipX = shape.clipX;
    part.clipY = shape.clipY;
    part.clipRadius = shape.clipRadius;
    return part;
  }
}

/**
 * A decal's anchor: the nearest drawable ancestor that is not a decal itself. A node is a decal if it
 * or an intermediate node up to the anchor is in `attached` mode (a pupil on an eye on a head,
 * the eye white in an eye group on a head): the anchor of all of them is the head. For the rest, `null`.
 */
function decalAnchor(node: Node | null): Node | null {
  if (!node) return null;
  let attached = node.sortMode === 'attached';
  for (let p = node.parent; p; p = p.parent) {
    if (isDrawable(p) && p.sortMode !== 'attached') return attached ? p : null;
    if (p.sortMode === 'attached') attached = true;
  }
  return null;
}

function nextItem(pool: DisplayItem[], index: number): DisplayItem {
  let item = pool[index];
  if (!item) {
    item = new DisplayItem();
    pool.push(item);
  }
  return item;
}

const target: [unknown, unknown] = [null, null];

/** Insertion sort: occluders (capsules) of larger radius first, then the rest. */
function sortByRadius(list: DisplayItem[]): void {
  const key = (item: DisplayItem) => (item.occluder === 'none' ? -1 : item.occluderRadius);
  for (let i = 1; i < list.length; i++) {
    const item = list[i] as DisplayItem;
    let j = i - 1;
    while (j >= 0 && key(list[j] as DisplayItem) < key(item)) {
      list[j + 1] = list[j] as DisplayItem;
      j--;
    }
    list[j + 1] = item;
  }
}

const cutter: Cutter = { kind: 'plane', x: 0, y: 0, depth: 0, radius: 0, scale: 1 };

/**
 * The occluder's cutting surface: a sphere by its front surface, a capsule by a plane.
 * The seam is searched along the stroke's axis, but the stroke itself is thick, so the sphere is inflated by
 * half its width `pad`: the visible part starts where the stroke edge, not its axis,
 * touches the surface. Otherwise a stroke end half a width wide would lie over the sphere.
 */
function setCutter(occluder: DisplayItem, pad: number): void {
  cutter.kind = occluder.occluder === 'sphere' ? 'sphere' : 'plane';
  cutter.x = occluder.occluderX;
  cutter.y = occluder.occluderY;
  cutter.depth = occluder.occluderDepth;
  cutter.radius = occluder.occluderRadius + (cutter.kind === 'sphere' ? pad : 0);
  cutter.scale = occluder.occluderScale;
}

// Bounds of the stroke currently being cut.
let minX = 0;
let minY = 0;
let maxX = 0;
let maxY = 0;

function bounds(item: DisplayItem): void {
  const { data, dataCount } = item.path;
  const pad = item.lineWidth / 2;
  minX = Number.POSITIVE_INFINITY;
  minY = Number.POSITIVE_INFINITY;
  maxX = Number.NEGATIVE_INFINITY;
  maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < dataCount; i += 2) {
    const x = data[i] ?? 0;
    const y = data[i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
}

/** Whether the bounds of the current stroke intersect the occluder on screen. */
function overlaps(occluder: DisplayItem): boolean {
  const r = occluder.occluderRadius;
  let ox0 = occluder.occluderX;
  let ox1 = occluder.occluderX;
  let oy0 = occluder.occluderY;
  let oy1 = occluder.occluderY;
  if (occluder.occluder === 'capsule') {
    ox0 = Math.min(ox0, occluder.occluderX2);
    ox1 = Math.max(ox1, occluder.occluderX2);
    oy0 = Math.min(oy0, occluder.occluderY2);
    oy1 = Math.max(oy1, occluder.occluderY2);
  }
  return minX <= ox1 + r && maxX >= ox0 - r && minY <= oy1 + r && maxY >= oy0 - r;
}

/**
 * Projects a shape's path into screen coordinates. Returns `false` if there is nothing
 * to draw: the back face is hidden, the shape is behind the camera eye or the path is a point without a stroke.
 */
function projectShape(shape: Shape, camera: Camera, out: DisplayItem): boolean {
  const style = shape.style;

  // Back face, as in Zdog: only if the `front` point is strictly farther from the camera
  // than the origin. A shape edge-on to the camera is drawn with its front face.
  shape.localToWorld(point, ORIGIN);
  const originDepth = camera.toView(point, point).z;
  front.x = shape.front.x;
  front.y = shape.front.y;
  front.z = shape.front.z;
  shape.localToWorld(point, front);
  const facingBack = camera.toView(point, point).z < originDepth;
  if (facingBack && !style.backfaceVisible) return false;

  camera.toView(point, shape.perspectiveReference.getWorldPosition(point));
  if (!camera.isInFront(point.z)) return false;
  const s = camera.scaleAt(point.z);

  mat3x4.multiply(modelView, camera.viewMatrix, shape.worldMatrix);
  // The node's scale for the stroke is the geometric mean of the scales along the shape's x and y axes:
  // flat shapes lie in that plane, so the z scale does not affect the width.
  // For uniform scale this is the exact scale.
  const world = shape.worldMatrix;
  const nodeScale = Math.sqrt(
    Math.hypot(world[0] ?? 0, world[1] ?? 0, world[2] ?? 0) *
      Math.hypot(world[3] ?? 0, world[4] ?? 0, world[5] ?? 0),
  );
  const lineWidth = style.stroke * nodeScale * s;
  const color = facingBack ? (style.backfaceColor ?? style.color) : style.color;

  const { ops, points, opCount } = shape.geometry;
  const path = out.path.reset();
  out.color = color;
  out.lineCap = 'round';

  if (opCount === 1) {
    // A point: a circle with a diameter equal to the stroke width, as in Zdog.
    if (lineWidth <= 0) return false;
    project(points, 0);
    path.arc(point.x * s, point.y * s, lineWidth / 2, 0, TAU).close();
    out.lineWidth = 0;
    out.hasStroke = false;
    out.hasFill = true;
    // A point with a thick stroke is a ball, like the mascot's head in Zdog: it occludes.
    out.setSphereOccluder(point.x * s, point.y * s, lineWidth / 2, point.z, s);
    return true;
  }

  let index = 0;
  for (let op = 0; op < opCount; op++) {
    const code = ops[op];
    if (code === PathOp.cubic) {
      project(points, index);
      const c1x = point.x * s;
      const c1y = point.y * s;
      const c1z = point.z;
      project(points, index + 1);
      const c2x = point.x * s;
      const c2y = point.y * s;
      const c2z = point.z;
      project(points, index + 2);
      path.cubicTo(c1x, c1y, c2x, c2y, point.x * s, point.y * s, c1z, c2z, point.z);
      index += 3;
    } else {
      project(points, index);
      if (code === PathOp.move) path.moveTo(point.x * s, point.y * s, point.z);
      else path.lineTo(point.x * s, point.y * s, point.z);
      index++;
    }
  }
  if (shape.geometry.closed) path.close();
  out.lineWidth = lineWidth;
  out.hasStroke = lineWidth > 0;
  out.hasFill = style.fill;
  out.splittable = !style.fill;
  return true;
}

/** Converts geometry point `index` into camera space (into `point`). */
function project(points: Float64Array, index: number): void {
  const i = index * 3;
  local.x = points[i] ?? 0;
  local.y = points[i + 1] ?? 0;
  local.z = points[i + 2] ?? 0;
  mat3x4.transformPoint(point, modelView, local);
}

const ORIGIN: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
const local: Vec3 = { x: 0, y: 0, z: 0 };
