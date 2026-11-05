import {
  color as colorMath,
  type Easing,
  type EasingSpec,
  easing,
  type Oklab,
  type Quat,
  quat,
  type Vec3,
} from '@mascotte/math';
import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { findProperty, type Property } from './properties.ts';

/*
 * Clips: keyed animation of node properties. A clip is plain data (it is saved in the
 * document as is): a duration, a loop mode and tracks. A track targets a node by id and one
 * of its registered properties, and holds keys `{ time, value, easing }`. The value at time
 * `t` depends only on `t`, so seeking gives exactly the frame playback would show.
 *
 * `bindClip` resolves nodes and properties once, validates the keys and converts their
 * values into flat arrays; `ClipBinding.apply(t)` then writes the values. Vectors and
 * quaternions need no allocation; the only per-frame allocations are numbers boxed at
 * polymorphic calls (the easing result and number setters) and color strings. Rig slots as
 * targets come with the rig (#22).
 */

/** All loop modes. */
export const LOOP_MODES = ['once', 'loop', 'pingpong'] as const;

/**
 * How time outside the clip is mapped into it: `once` holds the ends, `loop` repeats,
 * `pingpong` plays forward and backward in turn.
 */
export type LoopMode = (typeof LOOP_MODES)[number];

/** A key: the value at `time` (seconds) and the easing towards the next key (linear by default). */
export interface Key<V = unknown> {
  readonly time: number;
  readonly value: V;
  readonly easing?: EasingSpec;
}

/** Keys of one property of one node. */
export interface Track {
  /** Id of the target node. */
  readonly target: string;
  /** Property name from the registry: `rotation`, `style.color`, `width`. */
  readonly property: string;
  /** Keys sorted by time, within the clip duration. */
  readonly keys: readonly Key[];
}

export interface Clip {
  /** Duration in seconds. */
  readonly duration: number;
  readonly loop: LoopMode;
  readonly tracks: readonly Track[];
}

/**
 * Maps time `t` (seconds) into the clip `[0, duration]` according to the loop mode. A clip
 * of zero duration is always at 0.
 */
export function clipTime(duration: number, loop: LoopMode, t: number): number {
  if (!(duration > 0)) return 0;
  switch (loop) {
    case 'once':
      return Math.min(Math.max(t, 0), duration);
    case 'loop': {
      const local = t % duration;
      return local < 0 ? local + duration : local;
    }
    case 'pingpong': {
      const period = 2 * duration;
      let local = t % period;
      if (local < 0) local += period;
      return local <= duration ? local : period - local;
    }
  }
}

/**
 * Index `i` of the segment that contains `t`: `times[i] <= t < times[i + 1]`. Before the first
 * key it is -1, at or after the last key it is the last index.
 */
export function segmentAt(times: Float64Array, t: number): number {
  let lo = 0;
  let hi = times.length - 1;
  if (hi < 0 || t < (times[0] as number)) return -1;
  if (t >= (times[hi] as number)) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** A track ready to be applied: its node, property and keys converted to flat arrays. */
interface Bound {
  node: Node;
  property: Property;
  times: Float64Array;
  easings: Easing[];
  /** Numbers, vectors (3 per key) or quaternions (4 per key). */
  numbers: Float64Array;
  /** Colors in OKLab, `null` for a `null` key of a nullable color. */
  colors: (Oklab | null)[];
  /** Booleans and enum values, held until the next key. */
  steps: unknown[];
  /** Range of a number property: interpolated values are clamped into it. */
  lo: number;
  hi: number;
  /** Whether a number property only takes integers: interpolated values are rounded. */
  integer: boolean;
}

// Clip time of the current `apply`: kept in a typed array, not passed per track, so the
// number is not boxed on every call.
const now = new Float64Array(1);
const vec: Vec3 = { x: 0, y: 0, z: 0 };
const qa = quat.create();
const qb = quat.create();
const qOut = quat.create();
const lab = colorMath.createOklab();
const rgb = colorMath.create();

/** A clip bound to a scene: `apply(t)` sets every track's property to its value at `t`. */
export interface ClipBinding {
  readonly clip: Clip;
  /** Clip time for time `t`, after the loop mode. */
  localTime(t: number): number;
  /** Sets every track's property to its value at time `t` (seconds, before the loop mode). */
  apply(t: number): void;
}

class Binding implements ClipBinding {
  readonly clip: Clip;
  readonly #tracks: Bound[];

  constructor(clip: Clip, tracks: Bound[]) {
    this.clip = clip;
    this.#tracks = tracks;
  }

  /** Clip time for time `t`, after the loop mode. */
  localTime(t: number): number {
    return clipTime(this.clip.duration, this.clip.loop, t);
  }

  /** Sets every track's property to its value at time `t` (seconds, before the loop mode). */
  apply(t: number): void {
    now[0] = this.localTime(t);
    for (let i = 0; i < this.#tracks.length; i++) {
      const track = this.#tracks[i] as Bound;
      // A node destroyed after binding is skipped: bind again after changing the scene.
      if (!track.node.destroyed) applyTrack(track);
    }
  }
}

function applyTrack(track: Bound): void {
  const t = now[0] as number;
  const { property, times } = track;
  const last = times.length - 1;
  const at = segmentAt(times, t);
  // Before the first key, and at and after the last key, the end value is held.
  const i = Math.max(at, 0);
  const between = at >= 0 && at < last;
  let u = 0;
  if (between) {
    const t0 = times[i] as number;
    const t1 = times[i + 1] as number;
    u = t1 > t0 ? (track.easings[i] as Easing)((t - t0) / (t1 - t0)) : 1;
  }
  const n = track.numbers;
  switch (property.type) {
    case 'number': {
      const a = n[i] as number;
      if (!between) {
        property.set(track.node, a);
        return;
      }
      // Easings that overshoot (backOut, elastic) could leave the range between valid keys:
      // the value is clamped, and rounded for integer properties.
      let value = a + ((n[i + 1] as number) - a) * u;
      if (track.integer) value = Math.round(value);
      property.set(track.node, Math.min(Math.max(value, track.lo), track.hi));
      return;
    }
    case 'vec3': {
      const o = i * 3;
      const p = between ? o + 3 : o;
      const ax = n[o] as number;
      const ay = n[o + 1] as number;
      const az = n[o + 2] as number;
      vec.x = ax + ((n[p] as number) - ax) * u;
      vec.y = ay + ((n[p + 1] as number) - ay) * u;
      vec.z = az + ((n[p + 2] as number) - az) * u;
      property.set(track.node, vec);
      return;
    }
    case 'quat': {
      // Components are written directly: a call with four number arguments would box them.
      const o = i * 4;
      qa.x = n[o] as number;
      qa.y = n[o + 1] as number;
      qa.z = n[o + 2] as number;
      qa.w = n[o + 3] as number;
      if (between) {
        qb.x = n[o + 4] as number;
        qb.y = n[o + 5] as number;
        qb.z = n[o + 6] as number;
        qb.w = n[o + 7] as number;
        quat.slerp(qOut, qa, qb, u);
        property.set(track.node, qOut);
      } else property.set(track.node, qa);
      return;
    }
    case 'color': {
      const a = track.colors[i] as Oklab | null;
      const b = between ? (track.colors[i + 1] as Oklab | null) : a;
      // A `null` key (the fallback color) cannot be mixed: it is held like a step.
      if (a === null || b === null) {
        property.set(track.node, a === null ? null : colorMath.toHex(colorMath.fromOklab(rgb, a)));
        return;
      }
      colorMath.mixOklab(lab, a, b, between ? u : 0);
      property.set(track.node, colorMath.toHex(colorMath.fromOklab(rgb, lab)));
      return;
    }
    case 'bool':
      property.set(track.node, track.steps[i] as boolean);
      return;
    case 'enum':
      property.set(track.node, track.steps[i] as string);
      return;
  }
}

function fail(track: Track, message: string): never {
  throw new Error(`Track ${track.target}.${track.property}: ${message}`);
}

function isVec3(value: unknown): value is Vec3 {
  const v = value as Vec3;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y) &&
    Number.isFinite(v.z)
  );
}

/**
 * Binds a clip to the nodes of `scene`: finds every track's node and property, checks the
 * keys and their values, and prepares them for `apply`. Throws a RangeError for an invalid
 * duration or loop mode, and an error naming the track if a node or property is missing,
 * the property is not animatable, the track has no keys, keys are unsorted or outside the
 * clip, an easing is unknown, or a value does not fit the property (its type, range, or
 * integer constraint).
 *
 * Interpolated numbers are clamped into the property range and rounded for integer
 * properties, so easings that overshoot never produce invalid values. The binding keeps
 * references to the nodes: a node destroyed later is skipped, and a changed scene needs a
 * new binding.
 */
export function bindClip(clip: Clip, scene: Scene): ClipBinding {
  if (!(clip.duration >= 0 && Number.isFinite(clip.duration))) {
    throw new RangeError(
      `Clip duration must be a finite non-negative number, got ${clip.duration}.`,
    );
  }
  if (!(LOOP_MODES as readonly string[]).includes(clip.loop)) {
    throw new RangeError(`Unknown loop mode "${clip.loop}".`);
  }
  const bound: Bound[] = [];
  for (const track of clip.tracks) {
    const node = scene.getById(track.target);
    if (!node) fail(track, `no node with id "${track.target}" in the scene.`);
    const property = findProperty(node, track.property);
    if (!property) fail(track, `${node.typeName} has no property "${track.property}".`);
    if (!property.animatable) fail(track, 'the property is not animatable.');
    const keys = track.keys;
    if (keys.length === 0) fail(track, 'a track needs at least one key.');
    const times = new Float64Array(keys.length);
    const easings: Easing[] = [];
    const width = property.type === 'vec3' ? 3 : property.type === 'quat' ? 4 : 1;
    const numbers = new Float64Array(keys.length * width);
    const colors: (Oklab | null)[] = [];
    const steps: unknown[] = [];
    keys.forEach((key, k) => {
      const time = key.time;
      if (!(time >= 0 && time <= clip.duration)) {
        fail(track, `key ${k} time ${time} is outside the clip [0, ${clip.duration}].`);
      }
      if (k > 0 && time < (times[k - 1] as number))
        fail(track, `key ${k} is earlier than key ${k - 1}.`);
      times[k] = time;
      try {
        easings.push(easing.resolve(key.easing ?? 'linear'));
      } catch (error) {
        fail(track, `key ${k}: ${(error as Error).message}`);
      }
      const value = key.value;
      switch (property.type) {
        case 'number': {
          if (typeof value !== 'number' || !Number.isFinite(value)) {
            fail(track, `key ${k} must be a finite number.`);
          }
          const { min, max } = property;
          const below = min !== undefined && (property.exclusiveMin ? value <= min : value < min);
          if (below || (max !== undefined && value > max)) {
            fail(track, `key ${k} value ${value} is outside the property range.`);
          }
          if (property.integer && !Number.isInteger(value)) {
            fail(track, `key ${k} must be an integer.`);
          }
          numbers[k] = value;
          break;
        }
        case 'vec3':
          if (!isVec3(value)) fail(track, `key ${k} must be a vector {x, y, z}.`);
          numbers.set([value.x, value.y, value.z], k * 3);
          break;
        case 'quat': {
          const q = value as Quat;
          if (!isVec3(q) || !Number.isFinite(q.w) || quat.length(q) === 0) {
            fail(track, `key ${k} must be a non-zero quaternion {x, y, z, w}.`);
          }
          const unit = quat.normalize(quat.create(), q);
          numbers.set([unit.x, unit.y, unit.z, unit.w], k * 4);
          break;
        }
        case 'color': {
          if (value === null && property.nullable) {
            colors.push(null);
            break;
          }
          const parsed = typeof value === 'string' ? colorMath.parse(value) : null;
          if (!parsed)
            fail(track, `key ${k} must be a CSS color${property.nullable ? ' or null' : ''}.`);
          colors.push(colorMath.toOklab(colorMath.createOklab(), parsed));
          break;
        }
        case 'bool':
          if (typeof value !== 'boolean') fail(track, `key ${k} must be a boolean.`);
          steps.push(value);
          break;
        case 'enum':
          if (typeof value !== 'string' || !property.values.includes(value)) {
            fail(track, `key ${k} must be one of ${property.values.join(', ')}.`);
          }
          steps.push(value);
          break;
      }
    });
    let lo = Number.NEGATIVE_INFINITY;
    let hi = Number.POSITIVE_INFINITY;
    let integer = false;
    if (property.type === 'number') {
      integer = property.integer;
      if (property.min !== undefined) {
        // A strict minimum is approached but not reached.
        lo = property.exclusiveMin
          ? property.min + Math.max(Math.abs(property.min), 1) * Number.EPSILON
          : property.min;
      }
      if (property.max !== undefined) hi = property.max;
    }
    bound.push({ node, property, times, easings, numbers, colors, steps, lo, hi, integer });
  }
  return new Binding(clip, bound);
}
