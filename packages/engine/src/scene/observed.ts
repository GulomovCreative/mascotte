import type { Quat, Vec3 } from '@mascotte/math';

/**
 * Вектор, который сообщает владельцу об изменении. Поля читаются и пишутся как у
 * обычного `Vec3`, поэтому его можно передавать в функции `vec3` в качестве `out`.
 * Функции `vec3` пишут покомпонентно и могут сообщить до трёх раз: это дёшево, потому
 * что повторная пометка ничего не делает. Метод `set` сообщает не больше одного раза.
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

  /** Записывает все компоненты и сообщает об изменении не больше одного раза. */
  set(x: number, y: number, z: number): this {
    if (x !== this.#x || y !== this.#y || z !== this.#z) {
      this.#x = x;
      this.#y = y;
      this.#z = z;
      this.#onChange();
    }
    return this;
  }

  copy(v: Readonly<Vec3>): this {
    return this.set(v.x, v.y, v.z);
  }
}

/** Кватернион, который сообщает владельцу об изменении. */
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

  /** Записывает все компоненты и сообщает об изменении не больше одного раза. */
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

  copy(q: Readonly<Quat>): this {
    return this.set(q.x, q.y, q.z, q.w);
  }
}
