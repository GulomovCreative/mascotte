import { type Mat3x4, mat3x4, type Vec3 } from '@mascotte/math';
import { Node, type NodeOptions } from './node.ts';

/**
 * Camera projection.
 * - `orthographic`: no perspective, size does not depend on depth, as in Zdog.
 * - `perspective`: weak perspective, everything closer to the camera is larger. The scale
 *   depends on the depth of a reference point, so a shape can be scaled as a whole
 *   by the depth of its center, and circles stay circles.
 */
export type Projection = 'orthographic' | 'perspective';

export interface CameraOptions extends NodeOptions {
  projection?: Projection;
  /** Zoom: how many pixels one scene unit takes. */
  zoom?: number;
  /**
   * Distance from the eye to the camera node in perspective. The node is the picture plane, where
   * perspective does not change size; the eye stands `distance` behind it, at the local
   * point `(0, 0, distance)`. The smaller the distance, the stronger the perspective.
   */
  distance?: number;
}

/**
 * A point after projection: screen coordinates relative to the frame center, in pixels
 * (if `zoom` is given in pixels per scene unit), before devicePixelRatio is applied.
 */
export interface ProjectedPoint {
  /** Rightward. */
  x: number;
  /** Downward. */
  y: number;
  /** Depth in camera space: larger is closer to the viewer. */
  depth: number;
  /** How many times sizes at this point are enlarged (zoom and perspective). For stroke widths. */
  scale: number;
}

export function createProjectedPoint(): ProjectedPoint {
  return { x: 0, y: 0, depth: 0, scale: 1 };
}

function checkPositive(name: string, value: number): number {
  if (!(value > 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} must be a positive finite number, got ${value}.`);
  }
  return value;
}

/**
 * The camera is a scene node. The node's position and rotation define the view, so the camera can
 * be moved, rotated around the mascot or attached to rig nodes.
 *
 * The coordinate system is as in Zdog: x right, y down, z toward the viewer. The camera looks along −z
 * of its local frame. The camera node is the picture plane and the center of rotation:
 * a point at it lands in the frame center with scale `zoom`. In perspective the eye stands
 * `distance` behind the node (`getEyePosition`), as if a Zdog illustration were shot from afar.
 *
 * The scale of the camera node and its ancestors does not reach the frame: camera space is built
 * only from position and rotation. So the camera can be hung on any rig node,
 * and magnification is set only by `zoom`.
 *
 * The camera is part of `Scene.nodes` like a regular node; drawing skips it.
 */
export class Camera extends Node {
  static override readonly typeName: string = 'Camera';
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

  /** Projection change counter (`projection`, `zoom`, `distance`). */
  get projectionVersion(): number {
    return this.#projectionVersion;
  }

  /**
   * Matrix from world coordinates to camera space: the inverse of the node's position and rotation,
   * without scale and shear. Recomputed only after the position of the camera
   * or its ancestors changes. Throws if a camera axis is degenerate (scale 0 along an axis).
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
   * Eye position in world coordinates: the node's point `(0, 0, distance)` ignoring
   * scale. In orthographic projection there is no eye, `null` is returned.
   */
  getEyePosition(out: Vec3): Vec3 | null {
    if (this.#projection === 'orthographic') return null;
    const view = this.viewMatrix;
    // The camera's z axis in the world is the third row of the inverse rotation matrix.
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
   * Magnification for a point at depth `depth` in camera space. In orthographic projection it equals
   * `zoom`. In perspective it grows toward the eye and tends to infinity at the eye plane
   * (depth `distance`). For `depth ≥ distance` the result is meaningless (infinite or
   * negative): check `isInFront` first.
   */
  scaleAt(depth: number): number {
    if (this.#projection === 'orthographic') return this.#zoom;
    return (this.#zoom * this.#distance) / (this.#distance - depth);
  }

  /** Whether a point at depth `depth` is visible: in perspective, nothing on the eye plane or behind it is visible. */
  isInFront(depth: number): boolean {
    return this.#projection === 'orthographic' || depth < this.#distance;
  }

  /**
   * Projects a camera-space point. If `referenceDepth` is given, the scale is taken
   * from it rather than from the point's own depth: this way the whole shape scales the same (weak
   * perspective). Returns `false` and leaves `out` untouched if the reference point is not visible.
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

  /** Projects a world point. `referenceDepth` and the result mean the same as in `projectView`. */
  project(out: ProjectedPoint, world: Readonly<Vec3>, referenceDepth?: number): boolean {
    mat3x4.transformPoint(viewScratch, this.viewMatrix, world);
    return this.projectView(out, viewScratch, referenceDepth ?? viewScratch.z);
  }

  /** Converts a world point into camera space. */
  toView(out: Vec3, world: Readonly<Vec3>): Vec3 {
    return mat3x4.transformPoint(out, this.viewMatrix, world);
  }
}

const viewScratch: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Inverse of the rigid part of matrix `m`: the columns of the linear part are orthonormalized
 * (Gram–Schmidt, the third axis as a cross product); scale, translation and reflection
 * are discarded. The inverse of a rotation is its transpose.
 */
function rigidInverse(out: Mat3x4, m: Readonly<Mat3x4>, id: string): void {
  let xx = m[0]!;
  let xy = m[1]!;
  let xz = m[2]!;
  const xLength = Math.sqrt(xx * xx + xy * xy + xz * xz);
  let yx = m[3]!;
  let yy = m[4]!;
  let yz = m[5]!;
  if (xLength < 1e-12) throw new Error(`The x axis of camera "${id}" is degenerate.`);
  xx /= xLength;
  xy /= xLength;
  xz /= xLength;
  const along = xx * yx + xy * yy + xz * yz;
  yx -= along * xx;
  yy -= along * xy;
  yz -= along * xz;
  const yLength = Math.sqrt(yx * yx + yy * yy + yz * yz);
  if (yLength < 1e-12) throw new Error(`The y axis of camera "${id}" is degenerate.`);
  yx /= yLength;
  yy /= yLength;
  yz /= yLength;
  const zx = xy * yz - xz * yy;
  const zy = xz * yx - xx * yz;
  const zz = xx * yy - xy * yx;
  const tx = m[9]!;
  const ty = m[10]!;
  const tz = m[11]!;
  // The rows of the inverse matrix are the camera axes in the world.
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
