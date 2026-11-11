import type { AnimationLayer, Motion } from './animator.ts';
import { type InputRecord, type InputSpec, type Inputs, inputRecord } from './inputs.ts';

/*
 * State machines: which motion a layer plays, chosen by inputs. A machine drives one layer of
 * its animator. Each state plays a motion (a clip, a behavior set or a blend by a number
 * input) or nothing; transitions move from a state (or from any state) to another when all
 * their conditions on inputs hold, fading the new state's motion in over `duration` seconds,
 * and may wait for the state's clip to reach a point (`exitTime`, in clip durations). Several
 * machines run in parallel on different layers (body, face) and read the same inputs.
 *
 * A machine is made from plain data (a spec, which the document will save) by
 * `Animator.addStateMachine`. It steps in `Animator.update`, after the layers advance: its time
 * in the state grows by `dt`, and the first transition that can fire does, transitions from
 * any state before those of the current state, each in the order of the spec; at most one
 * fires per update. A transition from any state does not fire into the state the machine is
 * in. Triggers hold for one update (see inputs.ts), so a trigger whose transition waits for
 * an exit time it has not reached is lost. Machines keep state, so they are not seekable:
 * `reset()` starts one again from its initial state.
 */

/** The `from` of a transition that leaves any state. */
export const ANY_STATE = '*';

/** All condition operators. */
export const CONDITION_OPS = ['==', '!=', '<', '<=', '>', '>='] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

/**
 * A condition on an input. A trigger holds while fired (no `op` or `value`); a bool compares
 * with `==` (default) or `!=` to `value` (default `true`); a number needs an `op` and a finite
 * `value`.
 */
export interface ConditionSpec {
  readonly input: string;
  readonly op?: ConditionOp | null;
  readonly value?: boolean | number | null;
}

/** A transition between two states. It needs a condition or an exit time. */
export interface TransitionSpec {
  /** The state it leaves, or `'*'` for any state. */
  readonly from: string;
  readonly to: string;
  /** All of them must hold. */
  readonly conditions?: readonly ConditionSpec[] | null;
  /** Seconds the new state's motion fades in over the old one; 0 (default) switches at once. */
  readonly duration?: number | null;
  /**
   * Waits for the leaving state's clip to reach `exitTime` clip durations. A clip that plays
   * once can leave at that point or any time after; a looping (or ping-pong) one only when it
   * passes that point of a cycle, and the new state starts as far into its motion as the
   * clip went past the point. Only for transitions from a state that plays a clip.
   */
  readonly exitTime?: number | null;
}

/** A state: a name and the motion its layer plays (`null`, the default, stops the layer). */
export interface StateSpec {
  readonly name: string;
  readonly motion?: Motion | null;
}

export interface StateMachineSpec {
  /** Name for lookups and debugging. */
  readonly name?: string | null;
  /** The name of the animator layer the machine drives; one machine per layer. */
  readonly layer: string;
  /** Inputs the machine declares on its animator (see `Inputs.define`). */
  readonly inputs?: readonly InputSpec[] | null;
  /** At least one state; names are unique and not `'*'`. */
  readonly states: readonly StateSpec[];
  /** The state it starts in; the first one by default. */
  readonly initial?: string | null;
  readonly transitions?: readonly TransitionSpec[] | null;
}

/** Condition operators as numbers, so checking them every frame compares no strings. */
const Op = {
  Fired: 0,
  Equal: 1,
  NotEqual: 2,
  Less: 3,
  LessEqual: 4,
  Greater: 5,
  GreaterEqual: 6,
} as const;

type Op = (typeof Op)[keyof typeof Op];

const OP_CODES: Record<ConditionOp, Op> = {
  '==': Op.Equal,
  '!=': Op.NotEqual,
  '<': Op.Less,
  '<=': Op.LessEqual,
  '>': Op.Greater,
  '>=': Op.GreaterEqual,
};

interface Condition {
  readonly input: InputRecord;
  readonly op: Op;
  readonly value: number;
}

interface State {
  readonly name: string;
  readonly motion: Motion | null;
  /** Clip duration, or -1 when the state does not play a clip. */
  readonly duration: number;
  /** How often an exit point comes again: the loop period, or 0 for a clip played once. */
  readonly cycle: number;
  readonly transitions: Transition[];
}

interface Transition {
  readonly to: State;
  readonly conditions: readonly Condition[];
  readonly fade: number;
  /** In clip durations, or -1 for none. */
  readonly exitTime: number;
}

const SPEC_KEYS = new Set(['name', 'layer', 'inputs', 'states', 'initial', 'transitions']);
const STATE_KEYS = new Set(['name', 'motion']);
const TRANSITION_KEYS = new Set(['from', 'to', 'conditions', 'duration', 'exitTime']);
const CONDITION_KEYS = new Set(['input', 'op', 'value']);

function show(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function checkKeys(value: object, keys: ReadonlySet<string>, fail: (message: string) => never) {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`unknown option "${key}".`);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listOf<T>(
  value: readonly T[] | null | undefined,
  what: string,
  fail: (m: string) => never,
): readonly T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${what} must be a list.`);
  return value;
}

function isClip(motion: Motion): motion is Extract<Motion, { duration: number }> {
  return 'tracks' in motion;
}

/** Whether the time went from `prev` to `now` past an exit point of `transition`; the overshoot or -1. */
function exitOvershoot(state: State, exitTime: number, prev: number, now: number): number {
  const point = exitTime * state.duration;
  if (state.cycle <= 0) return now >= point ? now - Math.max(point, prev) : -1;
  let next = point;
  if (prev >= point) next += (Math.floor((prev - point) / state.cycle) + 1) * state.cycle;
  return next <= now ? now - next : -1;
}

function holds(conditions: readonly Condition[]): boolean {
  for (let i = 0; i < conditions.length; i++) {
    const { input, op, value } = conditions[i] as Condition;
    const v = input.value;
    let ok: boolean;
    switch (op) {
      case Op.Fired:
        ok = v === 1;
        break;
      case Op.Equal:
        ok = v === value;
        break;
      case Op.NotEqual:
        ok = v !== value;
        break;
      case Op.Less:
        ok = v < value;
        break;
      case Op.LessEqual:
        ok = v <= value;
        break;
      case Op.Greater:
        ok = v > value;
        break;
      case Op.GreaterEqual:
        ok = v >= value;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

let machineInternals!: {
  step(machine: StateMachine, dt: number): void;
};

/** A state machine driving one layer. Created by `Animator.addStateMachine`. */
export class StateMachine {
  readonly name: string;
  readonly layer: AnimationLayer;
  readonly #spec: StateMachineSpec;
  readonly #byName: ReadonlyMap<string, State>;
  readonly #any: readonly Transition[];
  readonly #initial: State;
  readonly #names: readonly string[];
  #state: State;
  #time = 0;

  /**
   * Checks `spec` against `inputs` (its own inputs must be declared already), passes the
   * motion of every state to `prepare` (which compiles it, and throws for a bad one) and
   * enters the initial state on `layer` at once. Throws an error naming the machine for a bad
   * spec.
   */
  constructor(
    spec: StateMachineSpec,
    layer: AnimationLayer,
    inputs: Inputs,
    prepare: (motion: Motion) => void,
  ) {
    const label =
      isObject(spec) && typeof spec.name === 'string' && spec.name !== ''
        ? `"${spec.name}"`
        : `on layer "${layer.name}"`;
    const fail = (message: string): never => {
      throw new Error(`State machine ${label}: ${message}`);
    };
    if (!isObject(spec)) fail('the spec must be an object.');
    checkKeys(spec, SPEC_KEYS, fail);
    if (spec.name !== undefined && spec.name !== null && typeof spec.name !== 'string') {
      fail('name must be a string.');
    }
    this.name = spec.name ?? '';
    this.layer = layer;
    const stateSpecs = listOf(spec.states, 'states', fail);
    if (stateSpecs.length === 0) fail('it needs at least one state.');
    const states: State[] = [];
    const byName = new Map<string, State>();
    for (const stateSpec of stateSpecs) {
      if (!isObject(stateSpec)) fail('a state must be an object { name, motion }.');
      checkKeys(stateSpec, STATE_KEYS, (m) => fail(`state ${show(stateSpec.name)}: ${m}`));
      const { name } = stateSpec;
      if (typeof name !== 'string' || name === '' || name === ANY_STATE) {
        fail(
          `a state name must be a non-empty string other than "${ANY_STATE}", got ${show(name)}.`,
        );
      }
      if (byName.has(name)) fail(`two states are named "${name}".`);
      const motion = stateSpec.motion ?? null;
      if (motion !== null && !isObject(motion)) {
        fail(`state "${name}": motion must be a clip, behaviors, a blend or null.`);
      }
      const clip = motion !== null && isClip(motion) ? motion : null;
      const duration = clip ? clip.duration : -1;
      const cycle =
        !clip || !(clip.duration > 0) || clip.loop === 'once'
          ? 0
          : clip.loop === 'loop'
            ? clip.duration
            : 2 * clip.duration;
      const state: State = { name, motion, duration, cycle, transitions: [] };
      states.push(state);
      byName.set(name, state);
    }
    const any: Transition[] = [];
    const transitionSpecs = listOf(spec.transitions, 'transitions', fail);
    for (let i = 0; i < transitionSpecs.length; i++) {
      const t = transitionSpecs[i] as TransitionSpec;
      const where = (m: string): never => fail(`transition ${i}: ${m}`);
      if (!isObject(t)) where('a transition must be an object { from, to, ... }.');
      checkKeys(t, TRANSITION_KEYS, where);
      const from = t.from === ANY_STATE ? null : byName.get(t.from);
      if (from === undefined) where(`no state ${show(t.from)} to leave.`);
      const to = byName.get(t.to);
      if (!to) where(`no state ${show(t.to)} to enter.`);
      const fade = t.duration ?? 0;
      if (!(typeof fade === 'number' && fade >= 0 && Number.isFinite(fade))) {
        where(`duration must be a finite non-negative number, got ${show(t.duration)}.`);
      }
      let exitTime = -1;
      if (t.exitTime !== undefined && t.exitTime !== null) {
        if (!(typeof t.exitTime === 'number' && t.exitTime >= 0 && Number.isFinite(t.exitTime))) {
          where(`exitTime must be a finite non-negative number, got ${show(t.exitTime)}.`);
        }
        if (!from || from.duration < 0) {
          where('exitTime needs a transition from a state that plays a clip.');
        }
        exitTime = t.exitTime;
      }
      const conditionSpecs = listOf(t.conditions, 'conditions', where);
      const conditions = conditionSpecs.map((c, k) =>
        compileCondition(c, inputs, (m) => where(`condition ${k}: ${m}`)),
      );
      if (conditions.length === 0 && exitTime < 0) {
        where('it needs a condition or an exitTime, or it would fire at once.');
      }
      const transition: Transition = { to: to as State, conditions, fade, exitTime };
      (from ? from.transitions : any).push(transition);
    }
    const initialName = spec.initial ?? (states[0] as State).name;
    const initial = byName.get(initialName);
    if (!initial) fail(`no initial state ${show(initialName)}.`);
    for (const state of states) {
      if (!state.motion) continue;
      try {
        prepare(state.motion);
      } catch (error) {
        fail(`state "${state.name}": ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.#byName = byName;
    this.#any = any;
    this.#initial = initial as State;
    this.#state = initial as State;
    this.#names = Object.freeze(states.map((state) => state.name));
    this.#spec = Object.freeze({ ...spec });
    this.#enter(this.#initial, 0, 0);
  }

  /** The name of the current state. */
  get state(): string {
    return this.#state.name;
  }

  /** Seconds spent in the current state (counted from where its motion started). */
  get time(): number {
    return this.#time;
  }

  /** The state names, in the order of the spec. */
  get states(): readonly string[] {
    return this.#names;
  }

  /** The spec the machine was made from (a copy; motions are shared, not copied). */
  toSpec(): StateMachineSpec {
    const spec = this.#spec;
    return {
      ...spec,
      ...(spec.inputs ? { inputs: spec.inputs.map((input) => ({ ...input })) } : {}),
      states: spec.states.map((state) => ({ ...state })),
      ...(spec.transitions
        ? {
            transitions: spec.transitions.map((t) => ({
              ...t,
              ...(t.conditions ? { conditions: t.conditions.map((c) => ({ ...c })) } : {}),
            })),
          }
        : {}),
    };
  }

  /**
   * Goes to state `name` at once, whatever the conditions, fading its motion in over `fade`
   * seconds. Throws for an unknown state.
   */
  setState(name: string, options: { readonly fade?: number } = {}): void {
    const state = this.#byName.get(name);
    if (!state) {
      throw new Error(
        `State machine "${this.name}": no state ${show(name)} (states: ${this.#names.join(', ')}).`,
      );
    }
    const fade = options.fade ?? 0;
    if (!(fade >= 0 && Number.isFinite(fade))) {
      throw new RangeError(`Fade must be a finite non-negative number, got ${fade}.`);
    }
    this.#enter(state, fade, 0);
  }

  /** Goes back to the initial state at once, at the start of its motion. */
  reset(): void {
    this.#enter(this.#initial, 0, 0);
  }

  #enter(state: State, fade: number, time: number): void {
    if (state.motion) this.layer.play(state.motion, { fade, time });
    else this.layer.stop({ fade });
    this.#state = state;
    this.#time = time;
  }

  #step(dt: number): void {
    const prev = this.#time;
    const now = prev + dt;
    this.#time = now;
    const state = this.#state;
    if (this.#try(this.#any, state, prev, now)) return;
    this.#try(state.transitions, state, prev, now);
  }

  /** Fires the first transition of `list` that can; returns whether one did. */
  #try(list: readonly Transition[], state: State, prev: number, now: number): boolean {
    for (let i = 0; i < list.length; i++) {
      const transition = list[i] as Transition;
      if (transition.to === state && list === this.#any) continue;
      let start = 0;
      if (transition.exitTime >= 0) {
        start = exitOvershoot(state, transition.exitTime, prev, now);
        if (start < 0) continue;
      }
      if (!holds(transition.conditions)) continue;
      this.#enter(transition.to, transition.fade, start);
      return true;
    }
    return false;
  }

  static {
    machineInternals = {
      step: (machine, dt) => machine.#step(dt),
    };
  }
}

function compileCondition(
  spec: ConditionSpec,
  inputs: Inputs,
  fail: (message: string) => never,
): Condition {
  if (!isObject(spec)) fail('a condition must be an object { input, op, value }.');
  checkKeys(spec, CONDITION_KEYS, fail);
  const input = typeof spec.input === 'string' ? inputRecord(inputs, spec.input) : undefined;
  if (!input) {
    fail(`no input ${show(spec.input)} (inputs: ${inputs.names.join(', ') || 'none'}).`);
  }
  const record = input as InputRecord;
  const op = spec.op ?? null;
  const value = spec.value ?? null;
  if (op !== null && !(CONDITION_OPS as readonly string[]).includes(op)) {
    fail(`op must be one of ${CONDITION_OPS.join(' ')}, got ${show(op)}.`);
  }
  switch (record.type) {
    case 'trigger':
      if (op !== null || value !== null)
        fail(`input "${record.name}" is a trigger: it takes no op or value.`);
      return { input: record, op: Op.Fired, value: 1 };
    case 'bool':
      if (op !== null && op !== '==' && op !== '!=') {
        fail(`input "${record.name}" is a bool: op must be == or !=, got ${show(op)}.`);
      }
      if (value !== null && typeof value !== 'boolean') {
        fail(`input "${record.name}" is a bool: value must be a boolean, got ${show(value)}.`);
      }
      return { input: record, op: OP_CODES[op ?? '=='], value: value === false ? 0 : 1 };
    case 'number':
      if (op === null) fail(`input "${record.name}" is a number: it needs an op.`);
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        fail(
          `input "${record.name}" is a number: value must be a finite number, got ${show(value)}.`,
        );
      }
      return { input: record, op: OP_CODES[op as ConditionOp], value: value as number };
  }
}

/** Steps `machine` by `dt` seconds; the animator calls it in `update`. */
export function stepMachine(machine: StateMachine, dt: number): void {
  machineInternals.step(machine, dt);
}
