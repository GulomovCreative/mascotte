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
    if (this.#length === this.#data.length) {
      const data = new Float32Array(this.#data.length * 2);
      data.set(this.#data);
      this.#data = data;
    }
    this.#data[this.#length++] = value;
  }
}
