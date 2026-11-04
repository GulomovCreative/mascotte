import { checkLength, type StyleParamSpec } from './params.ts';

/** Значения стиля фигуры. */
export interface ShapeStyleValues {
  /** Толщина обводки в единицах сцены; 0 — без обводки. */
  stroke: number;
  fill: boolean;
  /** Цвет CSS. */
  color: string;
  /** Рисовать ли обратную сторону. */
  backfaceVisible: boolean;
  /** Цвет обратной стороны; `null` — тот же, что у лицевой. */
  backfaceColor: string | null;
}

/**
 * Стиль фигуры одним объектом: так его проще сохранять в документ и позже заменить
 * цвет материалом. Каждое изменение увеличивает `appearanceVersion` фигуры.
 * Поля обратной стороны имеют смысл только для фигур с путём; для экранных
 * поверхностей они не используются (разделение стиля — вместе с материалами).
 */
export class ShapeStyle implements ShapeStyleValues {
  static readonly params = {
    stroke: { kind: 'length', default: 1 },
    fill: { kind: 'boolean', default: false },
    color: { kind: 'color', default: '#333' },
    backfaceVisible: { kind: 'boolean', default: true },
    backfaceColor: { kind: 'optionalColor', default: null },
  } as const satisfies Record<keyof ShapeStyleValues, StyleParamSpec>;

  #stroke: number;
  #fill: boolean;
  #color: string;
  #backfaceVisible: boolean;
  #backfaceColor: string | null;
  readonly #onChange: () => void;

  constructor(onChange: () => void, values: Partial<ShapeStyleValues> = {}) {
    const p = ShapeStyle.params;
    this.#onChange = onChange;
    this.#stroke = checkLength('stroke', values.stroke ?? p.stroke.default);
    this.#fill = values.fill ?? p.fill.default;
    this.#color = values.color ?? p.color.default;
    this.#backfaceVisible = values.backfaceVisible ?? p.backfaceVisible.default;
    this.#backfaceColor = values.backfaceColor ?? p.backfaceColor.default;
  }

  get stroke(): number {
    return this.#stroke;
  }
  set stroke(value: number) {
    if (checkLength('stroke', value) !== this.#stroke) {
      this.#stroke = value;
      this.#onChange();
    }
  }

  get fill(): boolean {
    return this.#fill;
  }
  set fill(value: boolean) {
    if (value !== this.#fill) {
      this.#fill = value;
      this.#onChange();
    }
  }

  get color(): string {
    return this.#color;
  }
  set color(value: string) {
    if (value !== this.#color) {
      this.#color = value;
      this.#onChange();
    }
  }

  get backfaceVisible(): boolean {
    return this.#backfaceVisible;
  }
  set backfaceVisible(value: boolean) {
    if (value !== this.#backfaceVisible) {
      this.#backfaceVisible = value;
      this.#onChange();
    }
  }

  get backfaceColor(): string | null {
    return this.#backfaceColor;
  }
  set backfaceColor(value: string | null) {
    if (value !== this.#backfaceColor) {
      this.#backfaceColor = value;
      this.#onChange();
    }
  }
}
