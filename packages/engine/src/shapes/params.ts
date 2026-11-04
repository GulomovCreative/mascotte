/**
 * Описание числового параметра фигуры. По этим схемам конструкторы берут значения
 * по умолчанию и проверяют ввод, а позже реестр свойств и формат документа узнают,
 * что можно анимировать и сохранять.
 */
export type ParamSpec =
  | { readonly kind: 'length'; readonly default: number }
  | {
      readonly kind: 'integer';
      readonly default: number;
      readonly min: number;
      readonly max?: number;
    };

/** Схема числовых параметров: имя → описание. */
export type ParamSchema = Readonly<Record<string, ParamSpec>>;

/** Описание поля стиля. */
export type StyleParamSpec =
  | { readonly kind: 'length'; readonly default: number }
  | { readonly kind: 'boolean'; readonly default: boolean }
  | { readonly kind: 'color'; readonly default: string }
  | { readonly kind: 'optionalColor'; readonly default: string | null };

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

/** Проверяет числовой параметр по его описанию. */
export function checkParam(name: string, spec: ParamSpec, value: number): number {
  return spec.kind === 'length'
    ? checkLength(name, value)
    : checkInteger(name, value, spec.min, spec.max);
}

/**
 * Хранилище числовых параметров по схеме `S`. Имена параметров проверяются на этапе
 * компиляции, значения — при записи. `onChange` вызывается только при реальном изменении.
 */
export class ParamStore<S extends ParamSchema> {
  readonly #schema: S;
  readonly #values = new Map<keyof S & string, number>();
  readonly #onChange: () => void;

  constructor(schema: S, options: object, onChange: () => void) {
    this.#schema = schema;
    this.#onChange = onChange;
    for (const name of Object.keys(schema) as (keyof S & string)[]) {
      const spec = schema[name] as ParamSpec;
      const given = (options as Readonly<Record<string, unknown>>)[name];
      const value = typeof given === 'number' ? given : spec.default;
      this.#values.set(name, checkParam(name, spec, value));
    }
  }

  get(name: keyof S & string): number {
    const value = this.#values.get(name);
    if (value === undefined) throw new Error(`Нет параметра ${name}.`);
    return value;
  }

  set(name: keyof S & string, value: number): void {
    const spec = this.#schema[name] as ParamSpec | undefined;
    if (!spec) throw new Error(`Нет параметра ${name}.`);
    if (checkParam(name, spec, value) !== this.#values.get(name)) {
      this.#values.set(name, value);
      this.#onChange();
    }
  }
}
