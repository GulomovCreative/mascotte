import type { AnimationLayer } from './animator.ts';
import type { Clip } from './clip.ts';
import {
  addInput,
  checkInput,
  type InputRecord,
  type InputSpec,
  type Inputs,
  removeInput,
} from './inputs.ts';
import { type Motion, motionKind } from './motion.ts';

/*
 * State machines: which motion a layer plays, chosen by inputs. A machine drives one layer of
 * its animator. Each state plays a motion (a clip, a behavior set or a blend by a number
 * input) or nothing; transitions move from a state (or from any state) to another when all
 * their conditions on inputs hold, fading the new state's motion in over `duration` seconds,
 * and may wait for the state's clip to reach a point (`exitTime`, in clip durations). Several
 * machines run in parallel on different layers (body, face) and read the same inputs; each
 * declares every input its conditions and blends read, so its spec stands on its own.
 *
 * A machine is made from plain data (a spec, which the document will save) by
 * `Animator.addStateMachine`. It steps in `Animator.update`, after the layers advance: the
 * first transition that can fire does, transitions from any state before those of the current
 * state, each in the order of the spec; at most one fires per update. A transition from any
 * state does not fire into the state the machine is in. Triggers hold for one update (see
 * inputs.ts), so a trigger that no transition of the current state uses, or whose transition
 * waits for an exit time it has not reached, is lost.
 *
 * The machine owns its layer: its time in a state that plays a motion is the layer's time
 * (`layer.time`, so seeking the layer moves it too), and other code should not play or stop
 * motions on that layer. When a transition's motion cannot be played (a node of it was
 * destroyed, or the rig's slots changed, and its targets no longer resolve), the machine
 * enters the state anyway with the layer stopped and says why in `problem`; it does not throw
 * from `update`. Machines keep state, so they are not seekable: `reset()` starts one again.
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
   * Waits until the time in the leaving state reaches `exitTime` clip durations; only for
   * transitions from a state that plays a clip. For a clip played once (or of zero duration)
   * the transition can fire at that point or any time after. For a looping clip the point
   * comes again every cycle, and for a ping-pong clip every two durations (values from 1 to 2
   * fall on the way back); the transition can fire only in the update that passes one. The
   * new state starts as far into its motion as the time went past the point within that
   * update.
   */
  readonly exitTime?: number | null;
}

/** A state: a name and the motion its layer plays (`null`, the default, stops the layer). */
export interface StateSpec {
  readonly name: string;
  readonly motion?: Motion | null;
}

export interface StateMachineSpec {
  /** Name for lookups, debugging and error messages. */
  readonly name?: string | null;
  /** The name of the animator layer the machine drives; one machine per layer. */
  readonly layer: string;
  /** Every input its conditions and blends read (see `Inputs.define`). */
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
  /** How often an exit point comes again: the loop period, or 0 when it does not. */
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

type Fail = (message: string) => never;

function show(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function checkKeys(value: object, keys: ReadonlySet<string>, fail: Fail): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) fail(`unknown option "${key}".`);
  }
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function listOf<T>(value: readonly T[] | null | undefined, what: string, fail: Fail): readonly T[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${what} must be a list.`);
  return value;
}

/** How often an exit point of `clip` comes again: its loop period, or 0 when it does not. */
function exitCycle(clip: Clip): number {
  if (!(clip.duration > 0)) return 0;
  switch (clip.loop) {
    case 'loop':
      return clip.duration;
    case 'once':
      return 0;
    default:
      return 2 * clip.duration;
  }
}

/**
 * How far the time went past an exit point of `state` at `exitTime` when it moved from `prev`
 * to `now`; -1 if it did not reach one.
 */
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
  detach(machine: StateMachine): void;
};

/** A state machine driving one layer. Created by `Animator.addStateMachine`. */
export class StateMachine {
  readonly name: string;
  readonly layer: AnimationLayer;
  readonly #label: string;
  readonly #spec: StateMachineSpec;
  readonly #byName: ReadonlyMap<string, State>;
  readonly #any: readonly Transition[];
  readonly #initial: State;
  readonly #names: readonly string[];
  #state: State;
  /** Time in the current state when the machine last looked. */
  #time = 0;
  #problem: string | null = null;
  #detached = false;

  /**
   * Checks `spec`, declares its inputs on `inputs`, passes the motion of every state to
   * `prepare` (which compiles it, and throws for a bad one) and enters the initial state on
   * `layer` at once. Throws an error naming the machine and the part for a bad spec, and then
   * declares nothing.
   */
  constructor(
    spec: StateMachineSpec,
    layer: AnimationLayer,
    inputs: Inputs,
    prepare: (motion: Motion) => void,
  ) {
    const named = isObject(spec) && typeof spec.name === 'string' && spec.name !== '';
    this.#label = `State machine ${named ? `"${spec.name}"` : `on layer "${layer.name}"`}`;
    const fail: Fail = (message) => {
      throw new Error(`${this.#label}: ${message}`);
    };
    if (!isObject(spec)) fail('the spec must be an object.');
    checkKeys(spec, SPEC_KEYS, fail);
    if (spec.name !== undefined && spec.name !== null && typeof spec.name !== 'string') {
      fail('name must be a string.');
    }
    this.name = spec.name ?? '';
    this.layer = layer;

    // Inputs: checked against those already declared, declared only once all is well.
    const declared = new Map<string, InputRecord>();
    const inputSpecs = listOf(spec.inputs, 'inputs', fail);
    for (let i = 0; i < inputSpecs.length; i++) {
      let record: InputRecord;
      try {
        record = checkInput(inputs, inputSpecs[i] as InputSpec);
      } catch (error) {
        throw new Error(`${this.#label}: input ${i}: ${messageOf(error)}`, { cause: error });
      }
      if (declared.has(record.name)) fail(`input ${i}: "${record.name}" is declared twice.`);
      declared.set(record.name, record);
    }

    const stateSpecs = listOf(spec.states, 'states', fail);
    if (stateSpecs.length === 0) fail('it needs at least one state.');
    const states: State[] = [];
    const byName = new Map<string, State>();
    for (const stateSpec of stateSpecs) {
      if (!isObject(stateSpec)) fail('a state must be an object { name, motion }.');
      const { name } = stateSpec;
      if (typeof name !== 'string' || name === '' || name === ANY_STATE) {
        fail(
          `a state name must be a non-empty string other than "${ANY_STATE}", got ${show(name)}.`,
        );
      }
      const where: Fail = (m) => fail(`state "${name}": ${m}`);
      checkKeys(stateSpec, STATE_KEYS, where);
      if (byName.has(name)) fail(`two states are named "${name}".`);
      const motion = stateSpec.motion ?? null;
      let kind = null;
      if (motion !== null) {
        try {
          kind = motionKind(motion);
        } catch (error) {
          where(messageOf(error));
        }
      }
      if (kind === 'blend') {
        const input = (motion as { readonly input: unknown }).input;
        if (typeof input !== 'string' || !declared.has(input)) {
          where(`its blend reads input ${show(input)}, which the machine does not declare.`);
        }
      }
      const clip = kind === 'clip' ? (motion as Clip) : null;
      const duration = clip ? clip.duration : -1;
      const cycle = clip ? exitCycle(clip) : 0;
      const state: State = { name, motion, duration, cycle, transitions: [] };
      states.push(state);
      byName.set(name, state);
    }

    const any: Transition[] = [];
    const transitionSpecs = listOf(spec.transitions, 'transitions', fail);
    for (let i = 0; i < transitionSpecs.length; i++) {
      const t = transitionSpecs[i] as TransitionSpec;
      const where: Fail = (m) => fail(`transition ${i}: ${m}`);
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
        compileCondition(c, declared, (m) => where(`condition ${k}: ${m}`)),
      );
      if (conditions.length === 0 && exitTime < 0) {
        where('it needs a condition or an exitTime, or it would fire at once.');
      }
      if (
        from === to &&
        exitTime < 0 &&
        !conditions.some((condition) => condition.op === Op.Fired)
      ) {
        where(
          'a transition into its own state needs a trigger or an exitTime, or it would restart ' +
            'the state every update while its conditions hold.',
        );
      }
      const transition: Transition = { to: to as State, conditions, fade, exitTime };
      (from ? from.transitions : any).push(transition);
    }

    const initialName = spec.initial ?? (states[0] as State).name;
    const initial = byName.get(initialName);
    if (!initial) fail(`no initial state ${show(initialName)}.`);

    // The spec is valid: declare the new inputs, then compile the motions (blends read
    // inputs), taking the inputs back if a motion fails.
    const added: string[] = [];
    for (const record of declared.values()) {
      if (inputs.has(record.name)) continue;
      addInput(inputs, record);
      added.push(record.name);
    }
    this.#byName = byName;
    this.#any = any;
    this.#initial = initial as State;
    this.#state = initial as State;
    this.#names = Object.freeze(states.map((state) => state.name));
    let current: State | null = null;
    try {
      for (const state of states) {
        current = state;
        if (state.motion) prepare(state.motion);
      }
      current = null;
      this.#enter(this.#initial, 0, 0);
    } catch (error) {
      for (const name of added) removeInput(inputs, name);
      const where = current ? `state "${current.name}"` : `initial state "${initialName}"`;
      throw new Error(`${this.#label}: ${where}: ${messageOf(error)}`, { cause: error });
    }
    this.#spec = snapshot(spec);
  }

  /** The name of the current state. */
  get state(): string {
    return this.#state.name;
  }

  /**
   * Seconds in the current state when the machine last stepped or entered it: the layer's
   * time for a state that plays a motion.
   */
  get time(): number {
    return this.#time;
  }

  /** The state names, in the order of the spec. */
  get states(): readonly string[] {
    return this.#names;
  }

  /**
   * Why the current state's motion is not playing, or `null`: a transition entered it, but
   * its motion could not be played (its targets no longer resolve), so the layer was stopped.
   */
  get problem(): string | null {
    return this.#problem;
  }

  /** A copy of the spec the machine was made from, taken when it was made; motions are shared. */
  toSpec(): StateMachineSpec {
    return snapshot(this.#spec, false);
  }

  /**
   * Goes to state `name` at once, whatever the conditions, fading its motion in over `fade`
   * seconds; for the current state, its motion starts again. Throws for an unknown state, a
   * motion that cannot be played, or a machine removed from its animator.
   */
  setState(name: string, options: { readonly fade?: number } = {}): void {
    this.#checkAttached();
    const state = this.#byName.get(name);
    if (!state) {
      throw new Error(
        `${this.#label}: no state ${show(name)} (states: ${this.#names.join(', ')}).`,
      );
    }
    const fade = options.fade ?? 0;
    if (!(fade >= 0 && Number.isFinite(fade))) {
      throw new RangeError(
        `${this.#label}: fade must be a finite non-negative number, got ${fade}.`,
      );
    }
    this.#enter(state, fade, 0);
  }

  /** Goes back to the initial state at once, at the start of its motion. Throws like `setState`. */
  reset(): void {
    this.#checkAttached();
    this.#enter(this.#initial, 0, 0);
  }

  #checkAttached(): void {
    if (this.#detached) throw new Error(`${this.#label}: it was removed from its animator.`);
  }

  /** Enters `state`, playing its motion from `time`; throws if the motion cannot be played. */
  #enter(state: State, fade: number, time: number): void {
    if (state.motion) this.layer.play(state.motion, { fade, time });
    else this.layer.stop({ fade });
    this.#state = state;
    this.#time = time;
    this.#problem = null;
  }

  #step(dt: number): void {
    const prev = this.#time;
    const state = this.#state;
    const now = state.motion && this.#problem === null ? this.layer.time : prev + dt;
    this.#time = now;
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
      try {
        this.#enter(transition.to, transition.fade, start);
      } catch (error) {
        // In the frame loop: enter the state with the layer stopped instead of throwing.
        this.layer.stop({ fade: transition.fade });
        this.#state = transition.to;
        this.#time = start;
        this.#problem = messageOf(error);
      }
      return true;
    }
    return false;
  }

  static {
    machineInternals = {
      step: (machine, dt) => machine.#step(dt),
      detach: (machine) => {
        machine.#detached = true;
      },
    };
  }
}

/** A deep copy of the lists and plain objects of `spec`, frozen or not; motions are shared. */
function snapshot(spec: StateMachineSpec, freeze = true): StateMachineSpec {
  const done = <T extends object>(value: T): T => (freeze ? Object.freeze(value) : value);
  const items = <T extends object>(list: readonly T[], map: (item: T) => T): readonly T[] =>
    done(list.map(map));
  const plain = <T extends object>(item: T): T => done({ ...item });
  const copy: { -readonly [K in keyof StateMachineSpec]: StateMachineSpec[K] } = {
    ...spec,
    states: items(spec.states, plain),
  };
  if (spec.inputs) copy.inputs = items(spec.inputs, plain);
  if (spec.transitions) {
    copy.transitions = items(spec.transitions, (t) =>
      done(t.conditions ? { ...t, conditions: items(t.conditions, plain) } : { ...t }),
    );
  }
  return done(copy);
}

function compileCondition(
  spec: ConditionSpec,
  declared: ReadonlyMap<string, InputRecord>,
  fail: Fail,
): Condition {
  if (!isObject(spec)) fail('a condition must be an object { input, op, value }.');
  checkKeys(spec, CONDITION_KEYS, fail);
  const input = typeof spec.input === 'string' ? declared.get(spec.input) : undefined;
  if (!input) {
    fail(
      `the machine does not declare input ${show(spec.input)} ` +
        `(its inputs: ${[...declared.keys()].join(', ') || 'none'}).`,
    );
  }
  const record = input as InputRecord;
  const op = spec.op ?? null;
  const value = spec.value ?? null;
  if (op !== null && !(CONDITION_OPS as readonly string[]).includes(op)) {
    fail(`op must be one of ${CONDITION_OPS.join(' ')}, got ${show(op)}.`);
  }
  switch (record.type) {
    case 'trigger':
      if (op !== null || value !== null) {
        fail(`input "${record.name}" is a trigger: it takes no op or value.`);
      }
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

/** Marks `machine` as removed from its animator: `setState` and `reset` throw from then on. */
export function detachMachine(machine: StateMachine): void {
  machineInternals.detach(machine);
}
