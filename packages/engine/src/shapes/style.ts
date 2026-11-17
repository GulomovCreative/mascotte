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
  /**
   * Color of the part turned away from the light (toon shading, see `render/tone.ts`); `null`
   * means no shadow. Spheres, capsules, points and lone strokes shade per point; a filled face
   * takes one tone by its normal; hemisphere domes and cylinder and cone sides are not shaded yet.
   * Its alpha is not used: the base color's applies.
   */
  shadowColor: string | null;
  /** Color of the part facing the light most (a toon highlight); `null` means no highlight. */
  highlightColor: string | null;
}

/**
 * Shape style as a single object, the shape's material: base color, shadow and highlight colors
 * (toon shading by the camera's light) and the back face color. Every change bumps the shape's
 * `appearanceVersion`. Back face fields only make sense for shapes with a path; screen surfaces
 * do not use them.
 */
export class ShapeStyle implements ShapeStyleValues {
  static readonly params = {
    stroke: { kind: 'length', default: 1 },
    fill: { kind: 'boolean', default: false },
    color: { kind: 'color', default: '#333' },
    backfaceVisible: { kind: 'boolean', default: true },
    backfaceColor: { kind: 'optionalColor', default: null },
    shadowColor: { kind: 'optionalColor', default: null },
    highlightColor: { kind: 'optionalColor', default: null },
  } as const satisfies Record<keyof ShapeStyleValues, StyleParamSpec>;

  #stroke: number;
  #fill: boolean;
  #color: string;
  #backfaceVisible: boolean;
  #backfaceColor: string | null;
  #shadowColor: string | null;
  #highlightColor: string | null;
  readonly #onChange: () => void;

  constructor(onChange: () => void, values: Partial<ShapeStyleValues> = {}) {
    const p = ShapeStyle.params;
    this.#onChange = onChange;
    this.#stroke = checkLength('stroke', values.stroke ?? p.stroke.default);
    this.#fill = values.fill ?? p.fill.default;
    this.#color = values.color ?? p.color.default;
    this.#backfaceVisible = values.backfaceVisible ?? p.backfaceVisible.default;
    this.#backfaceColor = values.backfaceColor ?? p.backfaceColor.default;
    this.#shadowColor = values.shadowColor ?? p.shadowColor.default;
    this.#highlightColor = values.highlightColor ?? p.highlightColor.default;
  }

  /** Whether the style shades: it has a shadow or a highlight color. */
  get toned(): boolean {
    return this.#shadowColor !== null || this.#highlightColor !== null;
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

  get shadowColor(): string | null {
    return this.#shadowColor;
  }
  set shadowColor(value: string | null) {
    if (value !== this.#shadowColor) {
      this.#shadowColor = value;
      this.#onChange();
    }
  }

  get highlightColor(): string | null {
    return this.#highlightColor;
  }
  set highlightColor(value: string | null) {
    if (value !== this.#highlightColor) {
      this.#highlightColor = value;
      this.#onChange();
    }
  }
}
