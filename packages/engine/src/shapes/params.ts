/**
 * Description of a shape's numeric parameter. Constructors use these schemas to take
 * default values and validate input; later the property registry and the document format
 * use them to learn what can be animated and saved.
 */
export type ParamSpec =
  | { readonly kind: 'length'; readonly default: number }
  | {
      readonly kind: 'integer';
      readonly default: number;
      readonly min: number;
      readonly max?: number;
    };

/** Numeric parameter schema: name → description. */
export type ParamSchema = Readonly<Record<string, ParamSpec>>;

/** Description of a style field. */
export type StyleParamSpec =
  | { readonly kind: 'length'; readonly default: number }
  | { readonly kind: 'boolean'; readonly default: boolean }
  | { readonly kind: 'color'; readonly default: string }
  | { readonly kind: 'optionalColor'; readonly default: string | null };

/** Checks that the value is a finite non-negative number. */
export function checkLength(name: string, value: number): number {
  if (!(value >= 0 && Number.isFinite(value))) {
    throw new RangeError(`${name} must be a finite non-negative number, got ${value}.`);
  }
  return value;
}

/** Checks that the value is an integer within a range. */
export function checkInteger(
  name: string,
  value: number,
  min: number,
  max = Number.POSITIVE_INFINITY,
): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.POSITIVE_INFINITY ? `at least ${min}` : `from ${min} to ${max}`;
    throw new RangeError(`${name} must be an integer ${range}, got ${value}.`);
  }
  return value;
}

/** Checks a numeric parameter against its description. */
export function checkParam(name: string, spec: ParamSpec, value: number): number {
  return spec.kind === 'length'
    ? checkLength(name, value)
    : checkInteger(name, value, spec.min, spec.max);
}

/**
 * Storage of numeric parameters by schema `S`. Parameter names are checked at
 * compile time, values on write. `onChange` is called only on an actual change.
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
    if (value === undefined) throw new Error(`No parameter ${name}.`);
    return value;
  }

  set(name: keyof S & string, value: number): void {
    const spec = this.#schema[name] as ParamSpec | undefined;
    if (!spec) throw new Error(`No parameter ${name}.`);
    if (checkParam(name, spec, value) !== this.#values.get(name)) {
      this.#values.set(name, value);
      this.#onChange();
    }
  }
}
