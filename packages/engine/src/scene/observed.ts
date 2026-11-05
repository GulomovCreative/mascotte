import type { Quat, Vec3 } from '@mascotte/math';

/**
 * A vector that notifies its owner of changes. Fields are read and written as on
 * a plain `Vec3`, so it can be passed to `vec3` functions as `out`.
 * `vec3` functions write per component and may notify up to three times: this is cheap because
 * a repeated mark does nothing. The `set` method notifies at most once.
 */
export class ObservedVec3 implements Vec3 {
  #x: number;
  #y: number;
  #z: number;
  readonly #onChange: () => void;

  constructor(onChange: () => void, x = 0, y = 0, z = 0) {
    this.#onChange = onChange;
    this.#x = x;
    this.#y = y;
    this.#z = z;
  }

  get x(): number {
    return this.#x;
  }
  set x(value: number) {
    if (value !== this.#x) {
      this.#x = value;
      this.#onChange();
    }
  }

  get y(): number {
    return this.#y;
  }
  set y(value: number) {
    if (value !== this.#y) {
      this.#y = value;
      this.#onChange();
    }
  }

  get z(): number {
    return this.#z;
  }
  set z(value: number) {
    if (value !== this.#z) {
      this.#z = value;
      this.#onChange();
    }
  }

  /** Writes all components and notifies of the change at most once. */
  set(x: number, y: number, z: number): this {
    if (x !== this.#x || y !== this.#y || z !== this.#z) {
      this.#x = x;
      this.#y = y;
      this.#z = z;
      this.#onChange();
    }
    return this;
  }

  /**
   * Copies `v`. It has its own body rather than calling `set`: passing the components as
   * number arguments would box them on every call in animation loops.
   */
  copy(v: Readonly<Vec3>): this {
    const x = v.x;
    const y = v.y;
    const z = v.z;
    if (x !== this.#x || y !== this.#y || z !== this.#z) {
      this.#x = x;
      this.#y = y;
      this.#z = z;
      this.#onChange();
    }
    return this;
  }
}

/** A quaternion that notifies its owner of changes. */
export class ObservedQuat implements Quat {
  #x = 0;
  #y = 0;
  #z = 0;
  #w = 1;
  readonly #onChange: () => void;

  constructor(onChange: () => void) {
    this.#onChange = onChange;
  }

  get x(): number {
    return this.#x;
  }
  set x(value: number) {
    if (value !== this.#x) {
      this.#x = value;
      this.#onChange();
    }
  }

  get y(): number {
    return this.#y;
  }
  set y(value: number) {
    if (value !== this.#y) {
      this.#y = value;
      this.#onChange();
    }
  }

  get z(): number {
    return this.#z;
  }
  set z(value: number) {
    if (value !== this.#z) {
      this.#z = value;
      this.#onChange();
    }
  }

  get w(): number {
    return this.#w;
  }
  set w(value: number) {
    if (value !== this.#w) {
      this.#w = value;
      this.#onChange();
    }
  }

  /** Writes all components and notifies of the change at most once. */
  set(x: number, y: number, z: number, w: number): this {
    if (x !== this.#x || y !== this.#y || z !== this.#z || w !== this.#w) {
      this.#x = x;
      this.#y = y;
      this.#z = z;
      this.#w = w;
      this.#onChange();
    }
    return this;
  }

  /** Copies `q`, with its own body for the same reason as `ObservedVec3.copy`. */
  copy(q: Readonly<Quat>): this {
    const x = q.x;
    const y = q.y;
    const z = q.z;
    const w = q.w;
    if (x !== this.#x || y !== this.#y || z !== this.#z || w !== this.#w) {
      this.#x = x;
      this.#y = y;
      this.#z = z;
      this.#w = w;
      this.#onChange();
    }
    return this;
  }
}
