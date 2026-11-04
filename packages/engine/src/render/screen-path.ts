/** Код операции экранного пути. */
export const ScreenOp = {
  /** x, y */
  move: 0,
  /** x, y */
  line: 1,
  /** две опорные точки и конечная: 6 чисел */
  cubic: 2,
  /** центр, радиус, начальный и конечный угол, направление (1 — против часовой): 6 чисел */
  arc: 3,
} as const;
export type ScreenOp = (typeof ScreenOp)[keyof typeof ScreenOp];

/** Сколько чисел у каждой операции, по коду. */
const SIZE = [2, 2, 6, 6] as const;

/**
 * Путь в экранных координатах (относительно центра кадра) в переиспользуемых буферах.
 * Команды повторяют Canvas 2D, поэтому бэкенд рисует его без преобразований.
 */
export class ScreenPath {
  #ops = new Uint8Array(8);
  #data = new Float64Array(32);
  #opCount = 0;
  #dataCount = 0;
  #closed = false;

  get ops(): Uint8Array {
    return this.#ops;
  }
  /** Числа команд подряд; сколько чисел у команды — см. `ScreenOp`. */
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

  reset(): this {
    this.#opCount = 0;
    this.#dataCount = 0;
    this.#closed = false;
    return this;
  }

  moveTo(x: number, y: number): this {
    const i = this.#reserve(ScreenOp.move);
    this.#data[i] = x;
    this.#data[i + 1] = y;
    return this;
  }

  lineTo(x: number, y: number): this {
    const i = this.#reserve(ScreenOp.line);
    this.#data[i] = x;
    this.#data[i + 1] = y;
    return this;
  }

  cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): this {
    const i = this.#reserve(ScreenOp.cubic);
    const d = this.#data;
    d[i] = c1x;
    d[i + 1] = c1y;
    d[i + 2] = c2x;
    d[i + 3] = c2y;
    d[i + 4] = x;
    d[i + 5] = y;
    return this;
  }

  /** Дуга окружности, как `CanvasRenderingContext2D.arc`. */
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

  /** Добавляет операцию и возвращает индекс, с которого писать её числа. */
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
