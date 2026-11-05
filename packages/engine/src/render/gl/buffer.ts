/** Растущий буфер чисел: переиспользуется между кадрами, растёт удвоением. */
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
   * Резервирует `count` чисел в конце и возвращает индекс первого: дальше их пишут прямо
   * в `data`. Так горячие циклы обходятся без вызова на каждое число.
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

/** Растущий буфер индексов: как `FloatBuffer`, но целые числа. */
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

/** Ломаная в экранном 3D: координаты в растущих массивах, переиспользуется между кадрами. */
export class Polyline {
  xs = new Float64Array(64);
  ys = new Float64Array(64);
  zs = new Float64Array(64);
  length = 0;

  clear(): void {
    this.length = 0;
  }

  /**
   * Добавляет точку и возвращает её индекс; координаты пишутся прямо в `xs`, `ys`, `zs`
   * после вызова. Без дробных аргументов вызов не упаковывает числа, даже если V8 его
   * не встроит.
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
 * Список, который каждый кадр заполняется заново без выделений памяти. Обнуление длины
 * массива в V8 может освободить его память, и следующие добавления выделят её снова, поэтому
 * элементы пишутся по индексу, а длина ставится один раз в конце: у той же сцены она не
 * меняется.
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
