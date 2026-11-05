/** Screen path operation code. */
export const ScreenOp = {
  /** x, y */
  move: 0,
  /** x, y */
  line: 1,
  /** two control points and an end point: 6 numbers */
  cubic: 2,
  /** center, radius, start and end angle, direction (1 means counterclockwise): 6 numbers */
  arc: 3,
} as const;
export type ScreenOp = (typeof ScreenOp)[keyof typeof ScreenOp];

/** How many numbers each operation has, by code. */
const SIZE = [2, 2, 6, 6] as const;

/**
 * A path in screen coordinates (relative to the frame center) in reusable buffers.
 * The commands follow Canvas 2D, so the backend draws it without conversion.
 */
export class ScreenPath {
  #ops = new Uint8Array(8);
  #data = new Float64Array(32);
  #depths = new Float64Array(16);
  #opCount = 0;
  #dataCount = 0;
  #pointCount = 0;
  #closed = false;

  get ops(): Uint8Array {
    return this.#ops;
  }
  /** Command numbers in sequence; how many numbers a command has, see `ScreenOp`. */
  get data(): Float64Array {
    return this.#data;
  }
  get opCount(): number {
    return this.#opCount;
  }
  get dataCount(): number {
    return this.#dataCount;
  }
  get closed(): boolean {
    return this.#closed;
  }
  /**
   * Camera-space depth of each `move`, `line` and `cubic` point, in order
   * (a curve has three points). The path is cut by the occluder plane using it. Arcs have no depth.
   */
  get depths(): Float64Array {
    return this.#depths;
  }
  /** Number of points with depth. */
  get pointCount(): number {
    return this.#pointCount;
  }

  reset(): this {
    this.#opCount = 0;
    this.#dataCount = 0;
    this.#pointCount = 0;
    this.#closed = false;
    return this;
  }

  moveTo(x: number, y: number, z = 0): this {
    const i = this.#reserve(ScreenOp.move);
    this.#data[i] = x;
    this.#data[i + 1] = y;
    this.#depth(z);
    return this;
  }

  lineTo(x: number, y: number, z = 0): this {
    const i = this.#reserve(ScreenOp.line);
    this.#data[i] = x;
    this.#data[i + 1] = y;
    this.#depth(z);
    return this;
  }

  cubicTo(
    c1x: number,
    c1y: number,
    c2x: number,
    c2y: number,
    x: number,
    y: number,
    c1z = 0,
    c2z = 0,
    z = 0,
  ): this {
    const i = this.#reserve(ScreenOp.cubic);
    const d = this.#data;
    d[i] = c1x;
    d[i + 1] = c1y;
    d[i + 2] = c2x;
    d[i + 3] = c2y;
    d[i + 4] = x;
    d[i + 5] = y;
    this.#depth(c1z);
    this.#depth(c2z);
    this.#depth(z);
    return this;
  }

  /** A circular arc, like `CanvasRenderingContext2D.arc`. */
  arc(
    cx: number,
    cy: number,
    radius: number,
    start: number,
    end: number,
    anticlockwise = false,
  ): this {
    const i = this.#reserve(ScreenOp.arc);
    const d = this.#data;
    d[i] = cx;
    d[i + 1] = cy;
    d[i + 2] = radius;
    d[i + 3] = start;
    d[i + 4] = end;
    d[i + 5] = anticlockwise ? 1 : 0;
    return this;
  }

  close(): this {
    this.#closed = true;
    return this;
  }

  #depth(z: number): void {
    if (this.#pointCount === this.#depths.length) {
      const depths = new Float64Array(this.#depths.length * 2);
      depths.set(this.#depths);
      this.#depths = depths;
    }
    this.#depths[this.#pointCount++] = z;
  }

  /** Adds an operation and returns the index from which to write its numbers. */
  #reserve(op: ScreenOp): number {
    if (this.#opCount === this.#ops.length) {
      const ops = new Uint8Array(this.#ops.length * 2);
      ops.set(this.#ops);
      this.#ops = ops;
    }
    const size = SIZE[op];
    const needed = this.#dataCount + size;
    if (needed > this.#data.length) {
      const data = new Float64Array(Math.max(needed, this.#data.length * 2));
      data.set(this.#data);
      this.#data = data;
    }
    this.#ops[this.#opCount++] = op;
    const start = this.#dataCount;
    this.#dataCount = needed;
    return start;
  }
}
