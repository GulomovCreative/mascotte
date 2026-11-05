import type { Vec3 } from '@mascotte/math';

/** A path point. Omitted coordinates are 0. */
export type PathPoint = Readonly<Partial<Vec3>>;

/**
 * A path command in the shape's local coordinates.
 * - `move` starts a new contour;
 * - `line` is a segment to a point;
 * - `bezier` is a cubic Bezier curve;
 * - `arc` is a quarter arc: from the current point to `point` through the corner `corner`, as in
 *   Zdog.
 */
export type PathCommand =
  | { readonly type: 'move'; readonly point: PathPoint }
  | { readonly type: 'line'; readonly point: PathPoint }
  | {
      readonly type: 'bezier';
      readonly control1: PathPoint;
      readonly control2: PathPoint;
      readonly point: PathPoint;
    }
  | { readonly type: 'arc'; readonly corner: PathPoint; readonly point: PathPoint };

/** Operation code in the built geometry. */
export const PathOp = {
  /** One point. */
  move: 0,
  /** One point. */
  line: 1,
  /** Three points: two control points and an end point. */
  cubic: 2,
} as const;
export type PathOp = (typeof PathOp)[keyof typeof PathOp];

/**
 * Handle length of the Bezier curve that replaces a quarter arc, as a fraction of the distance to
 * the corner. The value is from Zdog (`arcHandleLength = 9/16`) so the geometry matches. The exact
 * circle approximation is 4/3·tan(π/8) ≈ 0.5523.
 */
export const ARC_HANDLE = 9 / 16;

/**
 * Built path geometry: only `move`, `line` and cubic curves, arcs already replaced by curves. Only
 * the first `opCount` operations and `pointCount` points should be read. The arrays are reused
 * between rebuilds and replaced with new ones only when they grow, so references to `ops` and
 * `points` must not be kept longer than one `geometryVersion`.
 */
export interface PathGeometry {
  readonly ops: Uint8Array;
  /** Point coordinates in sequence: x, y, z. */
  readonly points: Float64Array;
  readonly opCount: number;
  readonly pointCount: number;
  /**
   * Whether to close the contour. A path of a single segment (`move` and `line`) is never closed.
   */
  readonly closed: boolean;
}

/**
 * Path builder into reusable buffers. The first command always becomes `move`:
 * if the path starts with another command, it starts at that command's end point. Zdog
 * in this case starts at the command's first point (a control point or the arc corner).
 */
export class PathBuilder implements PathGeometry {
  #ops = new Uint8Array(8);
  #points = new Float64Array(24);
  #opCount = 0;
  #pointCount = 0;
  #closed = false;
  #x = 0;
  #y = 0;
  #z = 0;

  get ops(): Uint8Array {
    return this.#ops;
  }
  get points(): Float64Array {
    return this.#points;
  }
  get opCount(): number {
    return this.#opCount;
  }
  get pointCount(): number {
    return this.#pointCount;
  }
  get closed(): boolean {
    return this.#closed;
  }

  reset(): this {
    this.#opCount = 0;
    this.#pointCount = 0;
    this.#closed = false;
    return this;
  }

  moveTo(x: number, y: number, z: number): this {
    this.#op(PathOp.move, 1);
    this.#point(x, y, z);
    return this;
  }

  lineTo(x: number, y: number, z: number): this {
    if (this.#opCount === 0) return this.moveTo(x, y, z);
    this.#op(PathOp.line, 1);
    this.#point(x, y, z);
    return this;
  }

  bezierTo(
    c1x: number,
    c1y: number,
    c1z: number,
    c2x: number,
    c2y: number,
    c2z: number,
    x: number,
    y: number,
    z: number,
  ): this {
    if (this.#opCount === 0) return this.moveTo(x, y, z);
    this.#op(PathOp.cubic, 3);
    this.#point(c1x, c1y, c1z);
    this.#point(c2x, c2y, c2z);
    this.#point(x, y, z);
    return this;
  }

  /** A quarter arc from the current point to `(x, y, z)` through the corner `(cx, cy, cz)`. */
  arcTo(cx: number, cy: number, cz: number, x: number, y: number, z: number): this {
    if (this.#opCount === 0) return this.moveTo(x, y, z);
    const px = this.#x;
    const py = this.#y;
    const pz = this.#z;
    return this.bezierTo(
      px + (cx - px) * ARC_HANDLE,
      py + (cy - py) * ARC_HANDLE,
      pz + (cz - pz) * ARC_HANDLE,
      x + (cx - x) * ARC_HANDLE,
      y + (cy - y) * ARC_HANDLE,
      z + (cz - z) * ARC_HANDLE,
      x,
      y,
      z,
    );
  }

  /** Adds path commands. */
  addCommands(commands: readonly PathCommand[]): this {
    for (const command of commands) {
      const p = command.point;
      switch (command.type) {
        case 'move':
          this.moveTo(p.x ?? 0, p.y ?? 0, p.z ?? 0);
          break;
        case 'line':
          this.lineTo(p.x ?? 0, p.y ?? 0, p.z ?? 0);
          break;
        case 'bezier': {
          const { control1: a, control2: b } = command;
          this.bezierTo(
            a.x ?? 0,
            a.y ?? 0,
            a.z ?? 0,
            b.x ?? 0,
            b.y ?? 0,
            b.z ?? 0,
            p.x ?? 0,
            p.y ?? 0,
            p.z ?? 0,
          );
          break;
        }
        case 'arc': {
          const c = command.corner;
          this.arcTo(c.x ?? 0, c.y ?? 0, c.z ?? 0, p.x ?? 0, p.y ?? 0, p.z ?? 0);
          break;
        }
      }
    }
    return this;
  }

  /** Sets closing according to the Zdog rule: a path of a single segment is not closed. */
  finish(closed: boolean): this {
    const isSegment = this.#opCount === 2 && this.#ops[1] === PathOp.line;
    this.#closed = closed && !isSegment;
    return this;
  }

  #op(op: PathOp, points: number): void {
    if (this.#opCount === this.#ops.length) {
      const ops = new Uint8Array(this.#ops.length * 2);
      ops.set(this.#ops);
      this.#ops = ops;
    }
    const needed = (this.#pointCount + points) * 3;
    if (needed > this.#points.length) {
      const grown = new Float64Array(Math.max(needed, this.#points.length * 2));
      grown.set(this.#points);
      this.#points = grown;
    }
    this.#ops[this.#opCount++] = op;
  }

  #point(x: number, y: number, z: number): void {
    const i = this.#pointCount * 3;
    this.#points[i] = x;
    this.#points[i + 1] = y;
    this.#points[i + 2] = z;
    this.#pointCount++;
    this.#x = x;
    this.#y = y;
    this.#z = z;
  }
}
