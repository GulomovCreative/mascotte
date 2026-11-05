/** Growable number buffer: reused between frames, grows by doubling. */
export class FloatBuffer {
  #data = new Float32Array(256);
  #length = 0;

  get data(): Float32Array {
    return this.#data;
  }
  get length(): number {
    return this.#length;
  }

  reset(): void {
    this.#length = 0;
  }

  push(value: number): void {
    if (this.#length === this.#data.length) this.#grow(this.#length + 1);
    this.#data[this.#length++] = value;
  }

  /**
   * Reserves `count` numbers at the end and returns the index of the first: they are then written
   * directly into `data`. This way hot loops avoid a call per number.
   */
  reserve(count: number): number {
    const start = this.#length;
    if (start + count > this.#data.length) this.#grow(start + count);
    this.#length = start + count;
    return start;
  }

  #grow(min: number): void {
    let size = this.#data.length * 2;
    while (size < min) size *= 2;
    const data = new Float32Array(size);
    data.set(this.#data.subarray(0, this.#length));
    this.#data = data;
  }
}

/** Growable index buffer: like `FloatBuffer`, but with integers. */
export class IndexBuffer {
  #data = new Int32Array(256);
  #length = 0;

  get data(): Int32Array {
    return this.#data;
  }
  get length(): number {
    return this.#length;
  }

  reset(): void {
    this.#length = 0;
  }

  push(value: number): void {
    if (this.#length === this.#data.length) {
      const data = new Int32Array(this.#data.length * 2);
      data.set(this.#data);
      this.#data = data;
    }
    this.#data[this.#length++] = value;
  }
}

/** Polyline in screen 3D: coordinates in growable arrays, reused between frames. */
export class Polyline {
  xs = new Float64Array(64);
  ys = new Float64Array(64);
  zs = new Float64Array(64);
  length = 0;

  clear(): void {
    this.length = 0;
  }

  /**
   * Adds a point and returns its index; the coordinates are written directly into `xs`, `ys`, `zs`
   * after the call. Without fractional arguments the call does not box numbers, even if V8
   * does not inline it.
   */
  add(): number {
    if (this.length === this.xs.length) {
      const size = this.xs.length * 2;
      this.xs = grow(this.xs, size);
      this.ys = grow(this.ys, size);
      this.zs = grow(this.zs, size);
    }
    return this.length++;
  }
}

function grow(data: Float64Array, size: number): Float64Array<ArrayBuffer> {
  const next = new Float64Array(size);
  next.set(data);
  return next;
}

/**
 * A list refilled every frame without memory allocations. Resetting an array's length
 * in V8 can free its memory, and the following pushes would allocate it again, so
 * elements are written by index and the length is set once at the end: for the same scene it
 * does not change.
 */
export class FrameList<T> {
  readonly items: T[] = [];
  count = 0;

  begin(): void {
    this.count = 0;
  }

  push(item: T): void {
    this.items[this.count++] = item;
  }

  end(): void {
    if (this.items.length !== this.count) this.items.length = this.count;
  }
}
