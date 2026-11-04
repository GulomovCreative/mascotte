/**
 * Описание параметра фигуры. По этим схемам конструкторы берут значения по умолчанию
 * и проверяют ввод, а позже реестр свойств и формат документа узнают, что можно
 * анимировать и сохранять.
 */
export type ParamSpec =
  | { readonly kind: 'length'; readonly default: number }
  | {
      readonly kind: 'integer';
      readonly default: number;
      readonly min: number;
      readonly max?: number;
    }
  | { readonly kind: 'boolean'; readonly default: boolean }
  | { readonly kind: 'color'; readonly default: string }
  | { readonly kind: 'optionalColor'; readonly default: string | null };

export type ParamSchema = Readonly<Record<string, ParamSpec>>;

/** Проверяет, что значение — конечное неотрицательное число. */
export function checkLength(name: string, value: number): number {
  if (!(value >= 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} должно быть конечным неотрицательным числом, получено ${value}.`);
  }
  return value;
}

/** Проверяет, что значение — целое число в диапазоне. */
export function checkInteger(
  name: string,
  value: number,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.POSITIVE_INFINITY ? `не меньше ${min}` : `от ${min} до ${max}`;
    throw new RangeError(`${name} должно быть целым числом ${range}, получено ${value}.`);
  }
  return value;
}

/** Проверяет числовой параметр по его схеме. */
export function checkNumberParam(name: string, spec: ParamSpec, value: number): number {
  if (spec.kind === 'length') return checkLength(name, value);
  if (spec.kind === 'integer') return checkInteger(name, value, spec.min, spec.max);
  throw new TypeError(`Параметр ${name} не числовой.`);
}

/**
 * Хранилище числовых параметров по схеме. Значения по умолчанию берутся из схемы,
 * ввод проверяется, а `onChange` вызывается только при реальном изменении.
 */
export class ParamStore {
  readonly #schema: ParamSchema;
  readonly #values = new Map<string, number>();
  readonly #onChange: () => void;

  constructor(schema: ParamSchema, options: object, onChange: () => void) {
    this.#schema = schema;
    this.#onChange = onChange;
    for (const [name, spec] of Object.entries(schema)) {
      const given = (options as Readonly<Record<string, unknown>>)[name];
      const value = typeof given === 'number' ? given : (spec.default as number);
      this.#values.set(name, checkNumberParam(name, spec, value));
    }
  }

  get(name: string): number {
    const value = this.#values.get(name);
    if (value === undefined) throw new Error(`Нет параметра ${name}.`);
    return value;
  }

  set(name: string, value: number): void {
    const spec = this.#schema[name];
    if (!spec) throw new Error(`Нет параметра ${name}.`);
    if (checkNumberParam(name, spec, value) !== this.#values.get(name)) {
      this.#values.set(name, value);
      this.#onChange();
    }
  }
}
