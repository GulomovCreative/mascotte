import {
  color as colorMath,
  type Easing,
  easing,
  type Oklab,
  quat,
  type Vec3,
} from '@mascotte/math';
import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { findProperty, type Property } from './properties.ts';

/*
 * Channels: animated values kept as numbers in a flat buffer, one channel per node
 * property. Clips are sampled into such a buffer, animation layers blend buffers, and the
 * result is written to the nodes once per frame.
 *
 * Encoding per property type:
 * - number: 1 value; vec3: x y z; quat: x y z w (unit);
 * - color: OKLab l a b and alpha; a `null` color (the fallback of a nullable color) is l = NaN;
 * - bool: 0 or 1; enum: the index of the value in `property.values` (a current value not in
 *   the list reads as 0).
 */

/** One animated node property and where its value lives in a buffer. */
export interface Channel {
  /** Index of the channel in its set. */
  readonly index: number;
  readonly node: Node;
  readonly property: Property;
  /** First value of the channel in a buffer. */
  readonly offset: number;
  /** Number of values, see the encoding above. */
  readonly size: number;
  /** Range of a number property: written values are clamped into it. */
  readonly lo: number;
  readonly hi: number;
  /** Whether a number property only takes integers: written values are rounded. */
  readonly integer: boolean;
}

function sizeOf(property: Property): number {
  switch (property.type) {
    case 'vec3':
      return 3;
    case 'quat':
    case 'color':
      return 4;
    default:
      return 1;
  }
}

/** Whether values of the type change in steps: they cannot be interpolated. */
function stepped(property: Property): boolean {
  return property.type === 'bool' || property.type === 'enum';
}

const vec: Vec3 = { x: 0, y: 0, z: 0 };
const qa = quat.create();
const qb = quat.create();
const qc = quat.create();
const la = colorMath.createOklab();
const lb = colorMath.createOklab();
const lc = colorMath.createOklab();
const rgb = colorMath.create();

function readQuat(out: typeof qa, buffer: Float64Array, o: number): typeof qa {
  out.x = buffer[o] as number;
  out.y = buffer[o + 1] as number;
  out.z = buffer[o + 2] as number;
  out.w = buffer[o + 3] as number;
  return out;
}

function writeQuat(buffer: Float64Array, o: number, q: typeof qa): void {
  buffer[o] = q.x;
  buffer[o + 1] = q.y;
  buffer[o + 2] = q.z;
  buffer[o + 3] = q.w;
}

function readLab(out: Oklab, buffer: Float64Array, o: number): Oklab {
  out.l = buffer[o] as number;
  out.a = buffer[o + 1] as number;
  out.b = buffer[o + 2] as number;
  out.alpha = buffer[o + 3] as number;
  return out;
}

function writeLab(buffer: Float64Array, o: number, c: Oklab): void {
  buffer[o] = c.l;
  buffer[o + 1] = c.a;
  buffer[o + 2] = c.b;
  buffer[o + 3] = c.alpha;
}

/**
 * Mixes the value of `channel` in `from` towards `to` by `t` (0 keeps `from`, 1 gives
 * `to`) into `out`; buffers may be the same. Numbers and vectors mix linearly, quaternions
 * with slerp, colors in OKLab; stepped values and `null` colors switch at `t >= 0.5`.
 */
export function mixChannel(
  channel: Channel,
  out: Float64Array,
  from: Float64Array,
  to: Float64Array,
  t: number,
): void {
  const o = channel.offset;
  const type = channel.property.type;
  if (
    stepped(channel.property) ||
    (type === 'color' && (Number.isNaN(from[o]) || Number.isNaN(to[o])))
  ) {
    const source = t >= 0.5 ? to : from;
    for (let k = 0; k < channel.size; k++) out[o + k] = source[o + k] as number;
    return;
  }
  if (type === 'quat') {
    quat.slerp(qc, readQuat(qa, from, o), readQuat(qb, to, o), t);
    writeQuat(out, o, qc);
    return;
  }
  if (type === 'color') {
    colorMath.mixOklab(lc, readLab(la, from, o), readLab(lb, to, o), t);
    writeLab(out, o, lc);
    return;
  }
  for (let k = 0; k < channel.size; k++) {
    const a = from[o + k] as number;
    out[o + k] = a + ((to[o + k] as number) - a) * t;
  }
}

/**
 * Adds to `pose` the difference of `sample` from `reference`, scaled by `weight`: additive
 * layers move the pose by how far their clip is from its first frame. Quaternions compose
 * the rotation from the reference; stepped values and `null` colors are not additive.
 */
export function addChannel(
  channel: Channel,
  pose: Float64Array,
  sample: Float64Array,
  reference: Float64Array,
  weight: number,
): void {
  const o = channel.offset;
  const type = channel.property.type;
  if (stepped(channel.property)) return;
  if (type === 'color') {
    if (Number.isNaN(pose[o]) || Number.isNaN(sample[o]) || Number.isNaN(reference[o])) return;
    for (let k = 0; k < 4; k++) {
      pose[o + k] =
        (pose[o + k] as number) +
        ((sample[o + k] as number) - (reference[o + k] as number)) * weight;
    }
    pose[o + 3] = Math.min(1, Math.max(0, pose[o + 3] as number));
    return;
  }
  if (type === 'quat') {
    // delta = sample · reference⁻¹, applied partially: slerp(identity, delta, weight) · pose.
    quat.invert(qb, readQuat(qb, reference, o));
    quat.multiply(qc, readQuat(qa, sample, o), qb);
    quat.identity(qa);
    quat.slerp(qb, qa, qc, weight);
    quat.multiply(qc, qb, readQuat(qa, pose, o));
    writeQuat(pose, o, qc);
    return;
  }
  for (let k = 0; k < channel.size; k++) {
    pose[o + k] =
      (pose[o + k] as number) + ((sample[o + k] as number) - (reference[o + k] as number)) * weight;
  }
}

/** Channels of node properties with a shared buffer layout. */
export class ChannelSet {
  readonly channels: Channel[] = [];
  #size = 0;
  readonly #byKey = new Map<string, Channel>();

  /** Total number of values in a buffer for these channels. */
  get size(): number {
    return this.#size;
  }

  /**
   * The channel of `property` on `node`, added if it is new. A node that replaced an earlier
   * one with the same id gets a new channel; the old one stays in the set.
   */
  channel(node: Node, property: Property): Channel {
    const key = `${node.id}\u0000${property.name}`;
    let channel = this.#byKey.get(key);
    if (channel && channel.node === node) return channel;
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
    channel = {
      index: this.channels.length,
      node,
      property,
      offset: this.#size,
      size: sizeOf(property),
      lo,
      hi,
      integer,
    };
    this.#size += channel.size;
    this.#byKey.set(key, channel);
    this.channels.push(channel);
    return channel;
  }

  /** Reads the current value of `channel` from its node into `buffer`. */
  read(channel: Channel, buffer: Float64Array): void {
    const { node, property, offset: o } = channel;
    switch (property.type) {
      case 'number':
        buffer[o] = property.get(node);
        return;
      case 'vec3': {
        const v = property.get(node, vec);
        buffer[o] = v.x;
        buffer[o + 1] = v.y;
        buffer[o + 2] = v.z;
        return;
      }
      case 'quat':
        writeQuat(buffer, o, property.get(node, qa));
        return;
      case 'color': {
        const css = property.get(node);
        const parsed = css === null ? null : colorMath.parse(css, rgb);
        if (parsed) writeLab(buffer, o, colorMath.toOklab(la, parsed));
        else buffer[o] = Number.NaN;
        return;
      }
      case 'bool':
        buffer[o] = property.get(node) ? 1 : 0;
        return;
      case 'enum':
        buffer[o] = Math.max(0, property.values.indexOf(property.get(node)));
        return;
    }
  }

  /**
   * Writes the value of `channel` in `buffer` to its node: numbers are rounded for integer
   * properties and clamped into the range, so blending and overshooting easings never
   * produce invalid values. A destroyed node is skipped.
   */
  write(channel: Channel, buffer: Float64Array): void {
    const { node, property, offset: o } = channel;
    if (node.destroyed) return;
    switch (property.type) {
      case 'number': {
        let value = buffer[o] as number;
        if (channel.integer) value = Math.round(value);
        property.set(node, Math.min(Math.max(value, channel.lo), channel.hi));
        return;
      }
      case 'vec3':
        vec.x = buffer[o] as number;
        vec.y = buffer[o + 1] as number;
        vec.z = buffer[o + 2] as number;
        property.set(node, vec);
        return;
      case 'quat':
        property.set(node, readQuat(qa, buffer, o));
        return;
      case 'color':
        if (Number.isNaN(buffer[o])) property.set(node, null);
        else property.set(node, colorMath.toHex(colorMath.fromOklab(rgb, readLab(la, buffer, o))));
        return;
      case 'bool':
        property.set(node, (buffer[o] as number) >= 0.5);
        return;
      case 'enum': {
        const values = property.values;
        const index = Math.min(values.length - 1, Math.max(0, Math.round(buffer[o] as number)));
        property.set(node, values[index] as string);
        return;
      }
    }
  }
}

/** A track compiled for sampling: its channel and its keys encoded like the channel. */
export interface SampledTrack {
  readonly channel: Channel;
  readonly times: Float64Array;
  readonly easings: readonly Easing[];
  /** Key values, `channel.size` numbers per key. */
  readonly values: Float64Array;
}

/** Clip time of the current sampling: a typed array, so it is not boxed per track. */
const now = new Float64Array(1);

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

const keyA = new Float64Array(4);
const keyB = new Float64Array(4);

/** Samples `tracks` at clip time `t` into `out` and marks their channels in `touched`. */
export function sampleTracks(
  tracks: readonly SampledTrack[],
  t: number,
  out: Float64Array,
  touched?: Uint8Array,
): void {
  now[0] = t;
  for (let i = 0; i < tracks.length; i++) sampleTrack(tracks[i] as SampledTrack, out, touched);
}

function sampleTrack(track: SampledTrack, out: Float64Array, touched?: Uint8Array): void {
  const t = now[0] as number;
  const { channel, times, values } = track;
  const size = channel.size;
  const o = channel.offset;
  if (touched) touched[channel.index] = 1;
  const last = times.length - 1;
  const at = segmentAt(times, t);
  // Before the first key, and at and after the last key, the end value is held.
  const i = Math.max(at, 0);
  if (at < 0 || at >= last) {
    for (let k = 0; k < size; k++) out[o + k] = values[i * size + k] as number;
    return;
  }
  // Stepped values and a `null` color key hold the current key until the next one.
  if (
    stepped(channel.property) ||
    (channel.property.type === 'color' &&
      (Number.isNaN(values[i * size]) || Number.isNaN(values[(i + 1) * size])))
  ) {
    for (let k = 0; k < size; k++) out[o + k] = values[i * size + k] as number;
    return;
  }
  const t0 = times[i] as number;
  const t1 = times[i + 1] as number;
  const u = (track.easings[i] as Easing)((t - t0) / (t1 - t0));
  // Mix the two keys through the channel rules, using small scratch buffers laid out at 0.
  for (let k = 0; k < size; k++) {
    keyA[k] = values[i * size + k] as number;
    keyB[k] = values[(i + 1) * size + k] as number;
  }
  mixChannel(localChannel(channel), keyA, keyA, keyB, u);
  for (let k = 0; k < size; k++) out[o + k] = keyA[k] as number;
}

// The same channel at offset 0, for mixing keys in the scratch buffers.
const local = new WeakMap<Channel, Channel>();
function localChannel(channel: Channel): Channel {
  let found = local.get(channel);
  if (!found) {
    found = { ...channel, offset: 0 };
    local.set(channel, found);
  }
  return found;
}

function fail(track: { target: string; property: string }, message: string): never {
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

/** What `compileTrack` needs to know about a track. */
export interface TrackSource {
  readonly target: string;
  readonly property: string;
  readonly keys: readonly {
    readonly time: number;
    readonly value: unknown;
    readonly easing?: unknown;
  }[];
}

/**
 * Compiles a track for sampling: finds its node and property, validates the keys against
 * the clip duration and the property, and encodes the values. Errors name the track. Adds
 * the track's channel to `set`.
 */
export function compileTrack(
  track: TrackSource,
  duration: number,
  scene: Scene,
  set: ChannelSet,
): SampledTrack {
  const node = scene.getById(track.target);
  if (!node) fail(track, `no node with id "${track.target}" in the scene.`);
  const property = findProperty(node, track.property);
  if (!property) fail(track, `${node.typeName} has no property "${track.property}".`);
  if (!property.animatable) fail(track, 'the property is not animatable.');
  const keys = track.keys;
  if (keys.length === 0) fail(track, 'a track needs at least one key.');
  const channel = set.channel(node, property);
  const size = channel.size;
  const times = new Float64Array(keys.length);
  const easings: Easing[] = [];
  const values = new Float64Array(keys.length * size);
  keys.forEach((key, k) => {
    const time = key.time;
    if (!(time >= 0 && time <= duration)) {
      fail(track, `key ${k} time ${time} is outside the clip [0, ${duration}].`);
    }
    if (k > 0 && time < (times[k - 1] as number)) {
      fail(track, `key ${k} is earlier than key ${k - 1}.`);
    }
    times[k] = time;
    try {
      easings.push(easing.resolve((key.easing ?? 'linear') as never));
    } catch (error) {
      fail(track, `key ${k}: ${(error as Error).message}`);
    }
    const value = key.value;
    const o = k * size;
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
        values[o] = value;
        break;
      }
      case 'vec3':
        if (!isVec3(value)) fail(track, `key ${k} must be a vector {x, y, z}.`);
        values[o] = value.x;
        values[o + 1] = value.y;
        values[o + 2] = value.z;
        break;
      case 'quat': {
        const q = value as typeof qa;
        if (!isVec3(q) || !Number.isFinite(q.w) || quat.length(q) === 0) {
          fail(track, `key ${k} must be a non-zero quaternion {x, y, z, w}.`);
        }
        writeQuat(values, o, quat.normalize(quat.create(), q));
        break;
      }
      case 'color': {
        if (value === null && property.nullable) {
          values[o] = Number.NaN;
          break;
        }
        const parsed = typeof value === 'string' ? colorMath.parse(value) : null;
        if (!parsed) {
          fail(track, `key ${k} must be a CSS color${property.nullable ? ' or null' : ''}.`);
        }
        writeLab(values, o, colorMath.toOklab(colorMath.createOklab(), parsed));
        break;
      }
      case 'bool':
        if (typeof value !== 'boolean') fail(track, `key ${k} must be a boolean.`);
        values[o] = value ? 1 : 0;
        break;
      case 'enum': {
        const index = typeof value === 'string' ? property.values.indexOf(value) : -1;
        if (index < 0) fail(track, `key ${k} must be one of ${property.values.join(', ')}.`);
        values[o] = index;
        break;
      }
    }
  });
  return { channel, times, easings, values };
}
