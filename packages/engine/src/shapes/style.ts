import { checkLength, type StyleParamSpec } from './params.ts';

/** Shape style values. */
export interface ShapeStyleValues {
  /** Stroke width in scene units; 0 means no stroke. */
  stroke: number;
  fill: boolean;
  /** CSS color. */
  color: string;
  /** Whether to draw the back face. */
  backfaceVisible: boolean;
  /** Back face color; `null` means the same as the front. */
  backfaceColor: string | null;
}

/**
 * Shape style as a single object: this makes it easier to save into a document and later
 * to replace color with a material. Every change bumps the shape's `appearanceVersion`.
 * Back face fields only make sense for shapes with a path; screen surfaces
 * do not use them (the style split comes together with materials).
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
