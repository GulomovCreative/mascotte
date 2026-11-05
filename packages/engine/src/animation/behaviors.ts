import { random } from '@mascotte/math';
import type { Scene } from '../scene/scene.ts';
import { type ChannelSet, compileTrack, type SampledTrack, sampleBetween } from './channels.ts';

/*
 * Procedural behaviors: motion described by a few numbers instead of keys, so the editor
 * configures it without code. A behavior moves one property of one node between two values,
 * `from` and `to`, by a curve of time:
 * - `oscillate` goes from `from` to `to` and back once per `period` (breathing, bobbing);
 * - `blink` stays at `from` and goes to `to` and back for `duration` seconds at random
 *   intervals from `minInterval` to `maxInterval` (blinking);
 * - `noise` wanders smoothly between `from` and `to` around their middle, passing the middle
 *   `frequency` times a second (sway, wobble).
 * Values mix like clip keys: numbers and vectors linearly, rotations with slerp, colors in
 * OKLab, and booleans and enums switch half way, so a blink can also show and hide shapes
 * (with `noise`, a boolean flips at least `frequency` times a second). Two behaviors of one
 * set on the same property do not combine: the later one wins, as with clip tracks; put them
 * on separate layers instead.
 *
 * The value at time `t` depends only on `t` (randomness comes from the `seed`), so seeking
 * gives the same frame as playback. At time 0 every behavior is at its neutral value (`from`
 * for `oscillate` with phase 0 and for `blink`, the middle for `noise`). Additive layers take
 * the value at time 0 as the reference, so an `oscillate` with a phase adds relative to its
 * phased start. Behaviors are played on animation layers in sets
 * (`BehaviorSet`), like clips.
 */

/** All behavior kinds. */
export const BEHAVIOR_KINDS = ['oscillate', 'blink', 'noise'] as const;

export type BehaviorKind = (typeof BEHAVIOR_KINDS)[number];

interface BehaviorBase {
  /** Id of the target node. */
  readonly target: string;
  /** Property name from the registry. */
  readonly property: string;
  /** The neutral value. */
  readonly from: unknown;
  /** The other end of the motion. */
  readonly to: unknown;
}

/** From `from` to `to` and back, smoothly (a cosine), once per `period` seconds. */
export interface Oscillate extends BehaviorBase {
  readonly kind: 'oscillate';
  readonly period: number;
  /** Shift in periods: 0 starts at `from`, 0.5 at `to`. Default 0. */
  readonly phase?: number;
}

/**
 * At `from`, and for `duration` seconds at random moments: to `to` in the first third and
 * back over the other two. Booleans and enums show `to` for the middle half of `duration`.
 * Blinks start from `minInterval` to `maxInterval` seconds apart; the first one starts within
 * `(maxInterval - minInterval) / 2` seconds after time 0.
 */
export interface Blink extends BehaviorBase {
  readonly kind: 'blink';
  /** Length of one blink in seconds; at most `minInterval`. */
  readonly duration: number;
  readonly minInterval: number;
  readonly maxInterval: number;
  /**
   * A 32-bit integer (negative seeds wrap: -1 equals 2^32 - 1); behaviors with the same seed
   * and intervals blink together. Default 0.
   */
  readonly seed?: number;
}

/**
 * Smooth noise between `from` and `to`, at their middle at time 0. It stays mostly near the
 * middle and rarely comes close to either end, so set `from` and `to` wider than the sway
 * you want.
 */
export interface Noise extends BehaviorBase {
  readonly kind: 'noise';
  /**
   * Noise cells per second: the value passes the middle every `1 / frequency` seconds and
   * turns about 1.5 times per cell on average.
   */
  readonly frequency: number;
  /**
   * A 32-bit integer. Behaviors with the same seed and frequency move together; give
   * independent motions different seeds. Default 0.
   */
  readonly seed?: number;
}

export type Behavior = Oscillate | Blink | Noise;

/** Behaviors played together on a layer. */
export interface BehaviorSet {
  readonly behaviors: readonly Behavior[];
}

/** A behavior ready to be sampled: its curve parameters and its two values as a track. */
interface CompiledBehavior {
  readonly kind: BehaviorKind;
  readonly track: SampledTrack;
  /** Period for `oscillate`, the mean interval for `blink`, frequency for `noise`. */
  readonly a: number;
  /**
   * Phase for `oscillate`; for `blink`, how far after its slot start a blink may begin (half
   * of `maxInterval - minInterval`).
   */
  readonly b: number;
  /** Blink duration. */
  readonly c: number;
  readonly seed: number;
}

/** A behavior set compiled against a scene. */
export interface CompiledBehaviors {
  readonly set: BehaviorSet;
  readonly tracks: readonly SampledTrack[];
  readonly behaviors: readonly CompiledBehavior[];
}

function smoothstep(u: number): number {
  return u * u * (3 - 2 * u);
}

/** How far a behavior is from `from` towards `to` at time `t`, from 0 to 1. */
function weightAt(behavior: CompiledBehavior, t: number): number {
  switch (behavior.kind) {
    case 'oscillate':
      return (1 - Math.cos(2 * Math.PI * (t / behavior.a + behavior.b))) / 2;
    case 'blink': {
      // Blink `j` starts in the slot [j·mean, (j + 1)·mean), within `spread` of its start:
      // starts are from mean − spread = minInterval to mean + spread = maxInterval apart. A
      // blink lasts at most minInterval, so it ends by j·mean + spread + minInterval =
      // (j + 1)·mean, inside its slot: only the blink of the current slot can be running.
      const mean = behavior.a;
      const slot = Math.floor(t / mean);
      const start = slot * mean + random.hash(behavior.seed, slot) * behavior.b;
      const x = (t - start) / behavior.c;
      if (!(x >= 0 && x < 1)) return 0;
      return x < 1 / 3 ? smoothstep(3 * x) : smoothstep(1.5 * (1 - x));
    }
    case 'noise':
      // The noise is within [-0.5, 0.5].
      return 0.5 + random.noise(behavior.seed, t * behavior.a);
  }
}

/** Samples the behaviors at time `t` into `out` and marks their channels in `touched`. */
export function sampleBehaviors(
  compiled: CompiledBehaviors,
  t: number,
  out: Float64Array,
  touched?: Uint8Array,
): void {
  const behaviors = compiled.behaviors;
  for (let i = 0; i < behaviors.length; i++) {
    const behavior = behaviors[i] as CompiledBehavior;
    sampleBetween(behavior.track, weightAt(behavior, t), out, touched);
  }
}

const VALUE_NAMES = ['from', 'to'];

function positive(behavior: Behavior, name: string, value: unknown): number {
  if (typeof value !== 'number' || !(value > 0 && Number.isFinite(value))) {
    fail(behavior, `${name} must be a finite positive number, got ${String(value)}.`);
  }
  return value;
}

function seedOf(behavior: Blink | Noise): number {
  const seed = behavior.seed ?? 0;
  if (!random.isSeed(seed)) fail(behavior, `seed must be a 32-bit integer, got ${seed}.`);
  return seed >>> 0;
}

function fail(behavior: Behavior, message: string): never {
  throw new RangeError(`Behavior ${behavior.target}.${behavior.property}: ${message}`);
}

function compileBehavior(behavior: Behavior, scene: Scene, set: ChannelSet): CompiledBehavior {
  const kind = behavior.kind;
  if (!(BEHAVIOR_KINDS as readonly string[]).includes(kind)) {
    fail(behavior, `unknown kind "${kind}".`);
  }
  let a = 0;
  let b = 0;
  let c = 0;
  let seed = 0;
  switch (kind) {
    case 'oscillate': {
      a = positive(behavior, 'period', behavior.period);
      b = behavior.phase ?? 0;
      if (!Number.isFinite(b)) fail(behavior, `phase must be finite, got ${b}.`);
      break;
    }
    case 'blink': {
      const min = positive(behavior, 'minInterval', behavior.minInterval);
      const max = positive(behavior, 'maxInterval', behavior.maxInterval);
      if (max < min) fail(behavior, `maxInterval ${max} is less than minInterval ${min}.`);
      c = positive(behavior, 'duration', behavior.duration);
      if (c > min) fail(behavior, `duration ${c} is longer than minInterval ${min}.`);
      a = (min + max) / 2;
      b = (max - min) / 2;
      seed = seedOf(behavior);
      break;
    }
    case 'noise':
      a = positive(behavior, 'frequency', behavior.frequency);
      seed = seedOf(behavior);
      break;
  }
  const track = compileTrack(
    {
      target: behavior.target,
      property: behavior.property,
      keys: [
        { time: 0, value: behavior.from },
        { time: 1, value: behavior.to },
      ],
    },
    1,
    scene,
    set,
    { what: 'Behavior', key: (k) => VALUE_NAMES[k] ?? `value ${k}` },
  );
  return { kind, track, a, b, c, seed };
}

/**
 * Compiles a behavior set against `scene` with channels from `channels`: checks every
 * behavior's kind and parameters (RangeError) and its node, property and values (an error
 * naming the behavior, as for clip tracks). Adds the behaviors' channels to `channels`.
 */
export function compileBehaviors(
  set: BehaviorSet,
  scene: Scene,
  channels: ChannelSet,
): CompiledBehaviors {
  const behaviors = set.behaviors.map((behavior) => compileBehavior(behavior, scene, channels));
  return { set, tracks: behaviors.map((behavior) => behavior.track), behaviors };
}
