import type { EasingSpec } from '@mascotte/math';
import type { Rig, Target, TargetScope } from '../rig/rig.ts';
import type { Scene } from '../scene/scene.ts';
import { ChannelSet, compileTrack, type SampledTrack, sampleTracks } from './channels.ts';

export { segmentAt } from './channels.ts';

/*
 * Clips: keyed animation of node properties. A clip is plain data (it is saved in the
 * document as is): a duration, a loop mode and tracks. A track targets a node (by id, or a
 * rig slot) and one of its registered properties, and holds keys `{ time, value, easing }`.
 * The value at time `t` depends only on `t`, so seeking gives exactly the frame playback
 * would show.
 *
 * `bindClip` resolves nodes and properties once, validates the keys and converts their
 * values into flat arrays; `ClipBinding.apply(t)` then writes the values. Vectors and
 * quaternions need no allocation; the only per-frame allocations are numbers boxed at
 * polymorphic calls (the easing result and number setters) and color strings.
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
  /** The target node: its id, or a rig slot `{ slot: 'head' }`. */
  readonly target: Target;
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

/** A clip compiled against a scene: its tracks ready to be sampled into channel buffers. */
export interface CompiledClip {
  readonly clip: Clip;
  readonly tracks: readonly SampledTrack[];
}

/**
 * Compiles a clip against `scope` with channels from `channels`: validates it and its
 * tracks (see `bindClip`) and encodes the keys. Used by `bindClip` and by animation layers.
 * Adds the tracks' channels to `channels`, also those compiled before a track that fails.
 */
export function compileClip(clip: Clip, scope: TargetScope, channels: ChannelSet): CompiledClip {
  if (!(clip.duration >= 0 && Number.isFinite(clip.duration))) {
    throw new RangeError(
      `Clip duration must be a finite non-negative number, got ${clip.duration}.`,
    );
  }
  if (!(LOOP_MODES as readonly string[]).includes(clip.loop)) {
    throw new RangeError(`Unknown loop mode "${clip.loop}".`);
  }
  const tracks = clip.tracks.map((track) => compileTrack(track, clip.duration, scope, channels));
  return { clip, tracks };
}

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
  readonly #compiled: CompiledClip;
  readonly #channels: ChannelSet;
  readonly #buffer: Float64Array;

  constructor(compiled: CompiledClip, channels: ChannelSet) {
    this.clip = compiled.clip;
    this.#compiled = compiled;
    this.#channels = channels;
    this.#buffer = new Float64Array(channels.size);
  }

  localTime(t: number): number {
    return clipTime(this.clip.duration, this.clip.loop, t);
  }

  apply(t: number): void {
    sampleTracks(this.#compiled.tracks, this.localTime(t), this.#buffer);
    const list = this.#channels.channels;
    for (let i = 0; i < list.length; i++)
      this.#channels.write(list[i] as (typeof list)[number], this.#buffer);
  }
}

export interface BindOptions {
  /** The rig that resolves slot targets; without one, a slot target is an error. */
  readonly rig?: Rig | null;
}

/**
 * Binds a clip to the nodes of `scene`: finds every track's node (through `options.rig` for
 * a slot) and property, checks the keys and their values, and prepares them for `apply`.
 * Throws a RangeError for an invalid duration or loop mode, and an error naming the track
 * if a node or property is missing, the property is not animatable, the track has no keys,
 * keys are unsorted or outside the clip, an easing is unknown, or a value does not fit the
 * property (its type, range, or integer constraint).
 *
 * Interpolated numbers are clamped into the property range and rounded for integer
 * properties, so easings that overshoot never produce invalid values. The binding keeps
 * references to the nodes: a node destroyed later is skipped, and a changed scene needs a
 * new binding, as does a change of the rig's slots (the binding does not follow it).
 */
export function bindClip(clip: Clip, scene: Scene, options: BindOptions = {}): ClipBinding {
  const channels = new ChannelSet();
  const scope = { scene, rig: options.rig ?? null };
  return new Binding(compileClip(clip, scope, channels), channels);
}
