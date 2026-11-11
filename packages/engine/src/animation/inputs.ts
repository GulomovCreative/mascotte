/*
 * Inputs: named values that drive state machines and blends. An input is a `bool`, a `number`
 * or a `trigger`; page code (and later pointer events) sets them, and every state machine and
 * blend of an animator reads the same set, so one input can drive the body and the face at
 * once. A trigger is fired, not set: it holds for the next `Animator.update` only, so every
 * machine sees it in that frame, and it is cleared afterwards whether a transition used it or
 * not.
 */

/** All input types. */
export const INPUT_TYPES = ['bool', 'number', 'trigger'] as const;

export type InputType = (typeof INPUT_TYPES)[number];

/** An input declaration: its name, type and starting value (`false` or 0 by default). */
export interface InputSpec {
  readonly name: string;
  readonly type: InputType;
  /** A boolean for `bool`, a finite number for `number`; not allowed for `trigger`. */
  readonly value?: boolean | number | null;
}

/**
 * Input names: words of letters, digits and `_` joined by dots, starting with a letter (like
 * slot names).
 */
export const INPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;

/** The stored input: booleans and triggers as 0 or 1, so readers need no boxing. */
export interface InputRecord {
  readonly name: string;
  readonly type: InputType;
  value: number;
}

const INPUT_KEYS = new Set(['name', 'type', 'value']);

function describe(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/** Checks `spec` and gives the record it declares; throws a TypeError or a RangeError. */
function recordOf(spec: InputSpec): InputRecord {
  if (typeof spec !== 'object' || spec === null) {
    throw new TypeError('An input must be an object { name, type, value }.');
  }
  const { name, type, value } = spec;
  if (typeof name !== 'string' || !INPUT_NAME_PATTERN.test(name)) {
    throw new RangeError(
      `Input name ${describe(name)} must be words of letters, digits and _ joined by dots, ` +
        'starting with a letter.',
    );
  }
  for (const key of Object.keys(spec)) {
    if (!INPUT_KEYS.has(key)) throw new RangeError(`Input "${name}": unknown option "${key}".`);
  }
  if (!(INPUT_TYPES as readonly string[]).includes(type)) {
    throw new RangeError(
      `Input "${name}": type must be one of ${INPUT_TYPES.join(', ')}, got ${describe(type)}.`,
    );
  }
  return { name, type, value: encode(name, type, value ?? null) };
}

/** The stored form of `value` for an input of `type`; `null` gives the default. */
function encode(name: string, type: InputType, value: unknown): number {
  switch (type) {
    case 'bool':
      if (value === null) return 0;
      if (typeof value !== 'boolean') {
        throw new TypeError(`Input "${name}" is a bool, got ${describe(value)}.`);
      }
      return value ? 1 : 0;
    case 'number':
      if (value === null) return 0;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new TypeError(
          `Input "${name}" is a number and needs a finite one, got ${describe(value)}.`,
        );
      }
      return value;
    case 'trigger':
      if (value !== null) {
        throw new TypeError(`Input "${name}" is a trigger: it has no value, fire it instead.`);
      }
      return 0;
  }
}

let inputsInternals!: {
  record(inputs: Inputs, name: string): InputRecord | undefined;
  clearTriggers(inputs: Inputs): void;
};

/** The inputs of one animator. Created by the animator (`animator.inputs`). */
export class Inputs {
  readonly #records = new Map<string, InputRecord>();
  #triggers: InputRecord[] = [];

  /**
   * Declares an input. Declaring one that exists with the same type keeps its current value
   * (machines that share an input each declare it); another type throws.
   */
  define(spec: InputSpec): void {
    const record = recordOf(spec);
    const existing = this.#records.get(record.name);
    if (existing) {
      if (existing.type !== record.type) {
        throw new Error(
          `Input "${record.name}" is already a ${existing.type}, it cannot be declared a ${record.type}.`,
        );
      }
      return;
    }
    this.#records.set(record.name, record);
  }

  /** Whether an input named `name` is declared. */
  has(name: string): boolean {
    return this.#records.has(name);
  }

  /** The type of input `name`, or `undefined`. */
  typeOf(name: string): InputType | undefined {
    return this.#records.get(name)?.type;
  }

  /** Names of the declared inputs, in the order they were declared (a new list). */
  get names(): string[] {
    return [...this.#records.keys()];
  }

  /**
   * The value of input `name`: a boolean for `bool`, a number for `number`, and for `trigger`
   * whether it was fired since the last update. Throws for an unknown input.
   */
  get(name: string): boolean | number {
    const record = this.#find(name);
    return record.type === 'number' ? record.value : record.value === 1;
  }

  /** Sets a `bool` or `number` input; throws for an unknown input, a trigger or a wrong value. */
  set(name: string, value: boolean | number): void {
    const record = this.#find(name);
    record.value = encode(name, record.type, value);
  }

  /** Fires a `trigger`: it holds for the next update. Throws for an unknown input or another type. */
  fire(name: string): void {
    const record = this.#find(name);
    if (record.type !== 'trigger') {
      throw new TypeError(`Input "${name}" is a ${record.type}, not a trigger: set it instead.`);
    }
    if (record.value === 0) {
      record.value = 1;
      this.#triggers.push(record);
    }
  }

  #find(name: string): InputRecord {
    const record = this.#records.get(name);
    if (!record) {
      const known = this.names.join(', ') || 'none';
      throw new Error(`No input "${String(name)}" (inputs: ${known}).`);
    }
    return record;
  }

  static {
    inputsInternals = {
      record: (inputs, name) => inputs.#records.get(name),
      clearTriggers: (inputs) => {
        const triggers = inputs.#triggers;
        if (triggers.length === 0) return;
        for (let i = 0; i < triggers.length; i++) (triggers[i] as InputRecord).value = 0;
        triggers.length = 0;
      },
    };
  }
}

/** The stored record of input `name`, read every frame without a lookup by its users. */
export function inputRecord(inputs: Inputs, name: string): InputRecord | undefined {
  return inputsInternals.record(inputs, name);
}

/** Clears the fired triggers; the animator calls it at the end of every update. */
export function clearTriggers(inputs: Inputs): void {
  inputsInternals.clearTriggers(inputs);
}
