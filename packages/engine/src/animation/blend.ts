import type { BehaviorSet } from './behaviors.ts';
import { type Channel, type ChannelSet, mixChannel, type SampledTrack } from './channels.ts';
import type { Clip } from './clip.ts';
import { type InputRecord, type Inputs, inputRecord } from './inputs.ts';

/*
 * Blend 1D: motions placed at values of a number input, mixed by where the input is between
 * them. Below the first point the first motion plays, above the last one the last; between
 * two points the two neighbors mix linearly (quaternions with slerp, colors in OKLab, stepped
 * values switching half way). All motions of a blend play at the same time, each with its own
 * loop mode. A blend animates every channel any of its motions animates; a motion that does
 * not animate a channel gives it its rest value there, so the blend changes continuously as
 * the input moves. The input is read every frame while the blend plays; the reference of an
 * additive layer is the blend at time 0 with the input's value when it starts playing.
 */

/** A motion of a blend and the input value it is placed at. */
export interface BlendPoint {
  readonly at: number;
  readonly motion: Clip | BehaviorSet;
}

/** Motions mixed by a number input. */
export interface Blend1D {
  /** The number input that places the blend between its points. */
  readonly input: string;
  /** At least one point, in increasing order of `at`. */
  readonly blend: readonly BlendPoint[];
}

/** Something sampled into channel buffers: a compiled clip, behavior set or blend. */
export interface Sampler {
  readonly tracks: readonly SampledTrack[];
  /** Samples at `time` (seconds, before a clip's loop mode). */
  sample(time: number, out: Float64Array, touched?: Uint8Array): void;
}

/** Checks the shape of `motion` and gives the number input it reads; throws otherwise. */
export function checkBlend(motion: Blend1D, inputs: Inputs): InputRecord {
  const { input, blend } = motion;
  if (typeof input !== 'string') throw new TypeError('Blend: input must be an input name.');
  const record = inputRecord(inputs, input);
  if (!record) {
    const known = inputs.names.join(', ') || 'none';
    throw new Error(`Blend: no input "${input}" (inputs: ${known}).`);
  }
  if (record.type !== 'number') {
    throw new Error(`Blend: input "${input}" is a ${record.type}, a blend needs a number.`);
  }
  if (!Array.isArray(blend) || blend.length === 0) {
    throw new RangeError('Blend: blend must be a non-empty list of points { at, motion }.');
  }
  for (let i = 0; i < blend.length; i++) {
    const point = blend[i] as BlendPoint;
    if (typeof point !== 'object' || point === null) {
      throw new TypeError(`Blend: point ${i} must be an object { at, motion }.`);
    }
    if (!Number.isFinite(point.at)) {
      throw new RangeError(`Blend: point ${i} needs a finite at, got ${String(point.at)}.`);
    }
    if (i > 0 && !(point.at > (blend[i - 1] as BlendPoint).at)) {
      throw new RangeError(`Blend: points must be in increasing order of at (point ${i}).`);
    }
    const inner = point.motion as unknown;
    if (typeof inner !== 'object' || inner === null) {
      throw new TypeError(`Blend: point ${i} needs a motion (a clip or behaviors).`);
    }
    if ('blend' in inner) throw new TypeError(`Blend: point ${i} is a blend; blends do not nest.`);
  }
  return record;
}

/**
 * The sampler of a blend over `children` (the compiled motions of its points, in order),
 * reading `input` and, for channels a motion does not animate, the rest pose from `rest()`.
 * Sampling allocates nothing once its buffers have grown to the channel layout.
 */
export function blendSampler(
  points: readonly BlendPoint[],
  children: readonly Sampler[],
  input: InputRecord,
  channels: ChannelSet,
  rest: () => Float64Array,
): Sampler {
  const tracks = children.flatMap((child) => child.tracks);
  // The channels of the blend: each once, in the order the tracks list them.
  const union: Channel[] = [];
  for (const track of tracks) {
    if (!union.includes(track.channel)) union.push(track.channel);
  }
  const at = Float64Array.from(points, (point) => point.at);
  const last = at.length - 1;
  let first = new Float64Array(0);
  let second = new Float64Array(0);
  let touchedFirst = new Uint8Array(0);
  let touchedSecond = new Uint8Array(0);
  const sampleInto = (child: Sampler, time: number, out: Float64Array, touched: Uint8Array) => {
    touched.fill(0);
    child.sample(time, out, touched);
  };
  return {
    tracks,
    sample(time, out, touched) {
      if (first.length < channels.size) {
        first = new Float64Array(channels.size);
        second = new Float64Array(channels.size);
      }
      if (touchedFirst.length < channels.channels.length) {
        touchedFirst = new Uint8Array(channels.channels.length);
        touchedSecond = new Uint8Array(channels.channels.length);
      }
      const value = input.value;
      let a = 0;
      let f = 0;
      if (value >= (at[last] as number)) a = last;
      else if (value > (at[0] as number)) {
        while ((at[a + 1] as number) <= value) a++;
        f = (value - (at[a] as number)) / ((at[a + 1] as number) - (at[a] as number));
      }
      const pose = rest();
      sampleInto(children[a] as Sampler, time, first, touchedFirst);
      if (f > 0) sampleInto(children[a + 1] as Sampler, time, second, touchedSecond);
      for (let i = 0; i < union.length; i++) {
        const channel = union[i] as Channel;
        const c = channel.index;
        const from = touchedFirst[c] === 1 ? first : pose;
        if (f > 0) {
          mixChannel(channel, out, from, touchedSecond[c] === 1 ? second : pose, f);
        } else {
          for (let k = 0; k < channel.size; k++) {
            out[channel.offset + k] = from[channel.offset + k] as number;
          }
        }
        if (touched) touched[c] = 1;
      }
    },
  };
}
