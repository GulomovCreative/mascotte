import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { type BehaviorSet, compileBehaviors, sampleBehaviors } from './behaviors.ts';
import {
  addChannel,
  type Channel,
  ChannelSet,
  mixChannel,
  type SampledTrack,
  sampleTracks,
} from './channels.ts';
import { type Clip, clipTime, compileClip } from './clip.ts';
import { findProperty } from './properties.ts';
import { applySpring, Spring, type SpringOptions, stepSpring } from './springs.ts';

/*
 * Animator: animation layers over one scene. A layer plays motions: keyed clips or sets of
 * procedural behaviors (see behaviors.ts); in this file, "clip" stands for either. Every
 * property animated by a clip played on the animator becomes a channel; its value when such a
 * clip is first played is its rest pose, and it is not updated later (a behavior's `from` is
 * not the rest pose: an override layer below full weight blends it with rest). Each frame starts from the rest pose, and every layer blends
 * its clips into it in order:
 * - an override layer moves the pose towards its clips by its weight;
 * - an additive layer adds how far its clips are from their value at time 0, scaled by its
 *   weight (rotations compose). Booleans, enums and `null` colors are not additive.
 * A mask limits a layer to a node and its descendants. Playing a clip with a fade fades it in
 * over what the layer showed before, even in the middle of another fade. The result is
 * written to the nodes once per frame.
 *
 * The animator owns every property any of its clips has animated, for its whole lifetime: it
 * writes them every frame, so other code should not set them directly, and properties that no
 * layer animates at the moment return to rest. A motion is compiled once per object, so an
 * edited one must be a new object; it is recompiled when one of its nodes was destroyed.
 *
 * Springs (see springs.ts) run after the layers: each frame they turn their nodes from the
 * blended pose, parents before children. The animator owns the rotation of a spring's node
 * like an animated property, so the spring's turn does not build up from frame to frame.
 */

/** All layer blend modes. */
export const BLEND_MODES = ['override', 'additive'] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

export interface LayerOptions {
  /** Name for lookups and debugging. */
  readonly name?: string;
  /** Default `override`. */
  readonly mode?: BlendMode;
  /** From 0 to 1, default 1. */
  readonly weight?: number;
  /**
   * Id of the node whose subtree the layer affects; the whole scene by default. Membership is
   * taken from the hierarchy when the mask is set and when clips add channels; after
   * reparenting nodes, assign `layer.mask` again to refresh it.
   */
  readonly mask?: string | null;
}

export interface PlayOptions {
  /** Fade-in time in seconds over what the layer showed before; 0 switches at once. */
  readonly fade?: number;
  /** Starting time of the new clip in seconds. Default 0. */
  readonly time?: number;
}

function checkWeight(value: number): number {
  if (!(value >= 0 && value <= 1)) {
    throw new RangeError(`Layer weight must be from 0 to 1, got ${value}.`);
  }
  return value;
}

function checkFade(value: number): number {
  if (!(value >= 0 && Number.isFinite(value))) {
    throw new RangeError(`Fade must be a finite non-negative number, got ${value}.`);
  }
  return value;
}

function checkTime(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} must be finite, got ${value}.`);
  return value;
}

/** What a layer plays: a keyed clip or a set of procedural behaviors. */
export type Motion = Clip | BehaviorSet;

/** A motion compiled against the animator's scene and channels. */
interface CompiledMotion {
  readonly motion: Motion;
  readonly tracks: readonly SampledTrack[];
  /** Samples the motion at `time` (seconds, before a clip's loop mode). */
  sample(time: number, out: Float64Array, touched?: Uint8Array): void;
}

function compileMotion(motion: Motion, scene: Scene, channels: ChannelSet): CompiledMotion {
  if ('behaviors' in motion) {
    const compiled = compileBehaviors(motion, scene, channels);
    return {
      motion,
      tracks: compiled.tracks,
      sample: (time, out, touched) => sampleBehaviors(compiled, time, out, touched),
    };
  }
  const { tracks } = compileClip(motion, scene, channels);
  const { duration, loop } = motion;
  return {
    motion,
    tracks,
    sample: (time, out, touched) =>
      sampleTracks(tracks, clipTime(duration, loop, time), out, touched),
  };
}

/** A clip playing on a layer: its compiled tracks, own time, buffers and touched channels. */
interface Playing {
  compiled: CompiledMotion;
  time: number;
  sample: Float64Array;
  /** The clip at time 0, the reference of additive layers. */
  reference: Float64Array;
  /** 1 for the channels the clip animates. */
  touched: Uint8Array;
}

/**
 * One step of a layer's history: a clip (or `null` after `stop`) fading in over the entries
 * before it. Once an entry has fully faded in, the entries before it are dropped.
 */
interface Entry {
  readonly playing: Playing | null;
  readonly fade: number;
  elapsed: number;
  /** Share of the entry in the layer output, for additive layers; set every frame. */
  share: number;
}

function progress(entry: Entry): number {
  return entry.fade > 0 ? Math.min(1, entry.elapsed / entry.fade) : 1;
}

/** `buffer` grown to `length` values, keeping its contents. */
function grownFloats(buffer: Float64Array, length: number): Float64Array {
  if (buffer.length >= length) return buffer;
  const next = new Float64Array(length);
  next.set(buffer);
  return next;
}

/** Samples the clip of `playing` at its time, growing its buffers to the channel layout. */
function samplePlaying(playing: Playing, size: number, count: number): void {
  playing.sample = grownFloats(playing.sample, size);
  playing.reference = grownFloats(playing.reference, size);
  if (playing.touched.length < count) playing.touched = new Uint8Array(count);
  playing.touched.fill(0);
  playing.compiled.sample(playing.time, playing.sample, playing.touched);
}

function copyChannel(channel: Channel, out: Float64Array, from: Float64Array): void {
  for (let k = 0; k < channel.size; k++) {
    out[channel.offset + k] = from[channel.offset + k] as number;
  }
}

let layerInternals!: {
  advance(layer: AnimationLayer, dt: number): void;
  blend(
    layer: AnimationLayer,
    pose: Float64Array,
    channels: readonly Channel[],
    target: Float64Array,
  ): void;
};

/** One animation layer. Created by `Animator.addLayer`. */
export class AnimationLayer {
  readonly name: string;
  readonly mode: BlendMode;
  readonly #animator: Animator;
  #weight: number;
  #mask: string | null;
  #maskFlags: Uint8Array | null = null;
  readonly #entries: Entry[] = [];

  constructor(animator: Animator, options: LayerOptions) {
    this.#animator = animator;
    this.name = options.name ?? '';
    const mode = options.mode ?? 'override';
    if (!(BLEND_MODES as readonly string[]).includes(mode)) {
      throw new RangeError(`Unknown blend mode "${mode}".`);
    }
    this.mode = mode;
    this.#weight = checkWeight(options.weight ?? 1);
    const mask = options.mask ?? null;
    if (mask !== null) this.#maskNode(mask);
    this.#mask = mask;
  }

  get weight(): number {
    return this.#weight;
  }
  set weight(value: number) {
    this.#weight = checkWeight(value);
  }

  /** Id of the masked subtree root, or `null` for the whole scene. Throws for an unknown id. */
  get mask(): string | null {
    return this.#mask;
  }
  set mask(id: string | null) {
    if (id !== null) this.#maskNode(id);
    this.#mask = id;
    this.#maskFlags = null;
  }

  /** The newest playing state, or `null` after `stop` or before any `play`. */
  get #current(): Playing | null {
    return this.#entries[this.#entries.length - 1]?.playing ?? null;
  }

  /** The motion playing now, or `null`. */
  get motion(): Motion | null {
    return this.#current?.compiled.motion ?? null;
  }

  /**
   * Time of the current clip in seconds (before its loop mode); 0 without one. Setting it
   * seeks the current clip only: clips fading out and fade progress are unchanged.
   */
  get time(): number {
    return this.#current?.time ?? 0;
  }
  set time(value: number) {
    checkTime(value, 'Layer time');
    const current = this.#current;
    if (current) current.time = value;
  }

  /** Whether a fade (a crossfade, a fade-in or a fading `stop`) is in progress. */
  get fading(): boolean {
    const entries = this.#entries;
    return entries.length > 1 || (entries.length === 1 && progress(entries[0] as Entry) < 1);
  }

  /**
   * Plays `motion` on this layer from `time`. With a `fade`, it fades in over what the layer
   * showed before (the previous clips keep playing until it has fully faded in); without
   * one, it replaces them at once.
   */
  play(motion: Motion, options: PlayOptions = {}): void {
    const fade = checkFade(options.fade ?? 0);
    const time = checkTime(options.time ?? 0, 'Start time');
    const playing = animatorInternals.playing(this.#animator, motion);
    playing.time = time;
    this.#push({ playing, fade, elapsed: 0, share: 0 });
  }

  /** Stops the layer; with a `fade`, its clips fade out first. */
  stop(options: { readonly fade?: number } = {}): void {
    const fade = checkFade(options.fade ?? 0);
    this.#push({ playing: null, fade, elapsed: 0, share: 0 });
  }

  #push(entry: Entry): void {
    this.#entries.push(entry);
    this.#prune();
  }

  /** Drops the entries hidden by a fully faded-in one, and a finished `stop`. */
  #prune(): void {
    const entries = this.#entries;
    for (let i = entries.length - 1; i > 0; i--) {
      if (progress(entries[i] as Entry) >= 1) {
        entries.splice(0, i);
        break;
      }
    }
    const first = entries[0];
    if (entries.length === 1 && first && first.playing === null && progress(first) >= 1) {
      entries.pop();
    }
  }

  #advance(dt: number): void {
    const entries = this.#entries;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] as Entry;
      if (entry.playing) entry.playing.time += dt;
      entry.elapsed += dt;
    }
    this.#prune();
  }

  #maskNode(id: string): Node {
    const node = animatorInternals.scene(this.#animator).getById(id);
    if (!node) throw new Error(`Layer mask: no node with id "${id}" in the scene.`);
    return node;
  }

  /** 1 for channels inside the mask, 0 outside; recomputed when channels are added. */
  #flags(channels: readonly Channel[]): Uint8Array | null {
    if (this.#mask === null) return null;
    let flags = this.#maskFlags;
    if (!flags || flags.length !== channels.length) {
      const root = this.#maskNode(this.#mask);
      flags = new Uint8Array(channels.length);
      for (let i = 0; i < channels.length; i++) {
        for (let n: Node | null = (channels[i] as Channel).node; n; n = n.parent) {
          if (n === root) {
            flags[i] = 1;
            break;
          }
        }
      }
      this.#maskFlags = flags;
    }
    return flags;
  }

  /**
   * Blends this layer into `pose`. Entries are combined oldest first: each one moves the layer
   * output towards its clip by its fade progress where the clip animates a channel, and
   * towards the pose below where it does not. Override layers keep the output as a target
   * per channel and how much of the layer weight it covers; additive layers add each clip by
   * its share.
   */
  #blend(pose: Float64Array, channels: readonly Channel[], target: Float64Array): void {
    const entries = this.#entries;
    const weight = this.#weight;
    if (entries.length === 0 || weight === 0) return;
    const mask = this.#flags(channels);
    let rest = 1;
    for (let e = entries.length - 1; e >= 0; e--) {
      const entry = entries[e] as Entry;
      const g = progress(entry);
      entry.share = g * rest;
      rest *= 1 - g;
      if (entry.playing) samplePlaying(entry.playing, pose.length, channels.length);
    }
    for (let i = 0; i < channels.length; i++) {
      if (mask && mask[i] === 0) continue;
      const channel = channels[i] as Channel;
      if (this.mode === 'additive') {
        for (let e = 0; e < entries.length; e++) {
          const entry = entries[e] as Entry;
          const playing = entry.playing;
          if (!playing) continue;
          if (playing.touched[i] !== 1 || entry.share === 0) continue;
          addChannel(channel, pose, playing.sample, playing.reference, weight * entry.share);
        }
        continue;
      }
      let a = 0;
      for (let e = 0; e < entries.length; e++) {
        const entry = entries[e] as Entry;
        const g = progress(entry);
        const playing = entry.playing;
        if (playing && playing.touched[i] === 1) {
          const next = a + (1 - a) * g;
          if (a === 0) copyChannel(channel, target, playing.sample);
          else mixChannel(channel, target, target, playing.sample, g / next);
          a = next;
        } else {
          a *= 1 - g;
        }
      }
      if (a > 0) mixChannel(channel, pose, pose, target, weight * a);
    }
  }

  static {
    layerInternals = {
      advance: (layer, dt) => layer.#advance(dt),
      blend: (layer, pose, channels, target) => layer.#blend(pose, channels, target),
    };
  }
}

function depthOf(node: Node): number {
  let depth = 0;
  for (let n = node.parent; n; n = n.parent) depth++;
  return depth;
}

let animatorInternals!: {
  playing(animator: Animator, motion: Motion): Playing;
  scene(animator: Animator): Scene;
};

/** Animation layers over one scene. Call `update(dt)` once per frame. */
export class Animator {
  readonly scene: Scene;
  readonly #channels = new ChannelSet();
  readonly #layers: AnimationLayer[] = [];
  readonly #compiled = new Map<Motion, CompiledMotion>();
  readonly #springs: Spring[] = [];
  #springsEnabled = true;
  #rest = new Float64Array(0);
  #pose = new Float64Array(0);
  /** The layer target while a layer blends. */
  #target = new Float64Array(0);

  constructor(scene: Scene) {
    this.scene = scene;
  }

  /** Layers in blend order. */
  get layers(): readonly AnimationLayer[] {
    return this.#layers;
  }

  /** Adds a layer on top of the existing ones. */
  addLayer(options: LayerOptions = {}): AnimationLayer {
    const layer = new AnimationLayer(this, options);
    this.#layers.push(layer);
    return layer;
  }

  /** The first layer named `name`, or `null`. */
  layer(name: string): AnimationLayer | null {
    return this.#layers.find((layer) => layer.name === name) ?? null;
  }

  /** Springs in the order they run: parents before children. */
  get springs(): readonly Spring[] {
    return this.#springs;
  }

  /**
   * Adds a spring on the node with id `options.target`. Throws for an unknown id and for
   * invalid parameters (RangeError). The node's current rotation becomes its rest pose if no
   * clip animated it yet.
   */
  addSpring(options: SpringOptions): Spring {
    const node = this.scene.getById(options.target);
    if (!node) throw new Error(`Spring: no node with id "${options.target}" in the scene.`);
    const spring = new Spring(node, options);
    const rotation = findProperty(node, 'rotation');
    if (!rotation) throw new Error(`Spring ${options.target}: the node has no rotation.`);
    const before = this.#channels.channels.length;
    this.#channels.channel(node, rotation);
    this.#grow(before);
    const depth = depthOf(node);
    let at = this.#springs.length;
    while (at > 0 && depthOf((this.#springs[at - 1] as Spring).node) > depth) at--;
    this.#springs.splice(at, 0, spring);
    return spring;
  }

  /** Removes `spring`; its node returns to the pose. */
  removeSpring(spring: Spring): void {
    const index = this.#springs.indexOf(spring);
    if (index >= 0) this.#springs.splice(index, 1);
  }

  /**
   * Whether springs run. While they are off the nodes show the plain pose, so seeking is
   * exact; turning them on again starts them at rest.
   */
  get springsEnabled(): boolean {
    return this.#springsEnabled;
  }
  set springsEnabled(value: boolean) {
    if (value && !this.#springsEnabled) this.resetSprings();
    this.#springsEnabled = value;
  }

  /**
   * Puts every spring at rest. To see springs at a seeked time, reset them with the layer
   * times and play up to it with `update`: the same frames give the same motion.
   */
  resetSprings(): void {
    for (const spring of this.#springs) spring.reset();
  }

  /**
   * Advances every layer by `dt` seconds, writes the blended pose to the nodes and simulates
   * the springs for `dt` from it.
   */
  update(dt: number): void {
    checkTime(dt, 'Animator dt');
    for (const layer of this.#layers) layerInternals.advance(layer, dt);
    this.#writePose();
    if (!this.#springsEnabled) return;
    for (const spring of this.#springs) {
      stepSpring(spring, dt);
      applySpring(spring);
    }
  }

  /**
   * Writes the blended pose for the layers' current times without advancing them, with the
   * springs in their current state. Outside fades and with springs off (or at rest), setting
   * layer times and evaluating gives the same frame as playing up to them; fade progress and
   * spring motion are not seekable.
   */
  evaluate(): void {
    this.#writePose();
    if (!this.#springsEnabled) return;
    for (const spring of this.#springs) applySpring(spring);
  }

  #writePose(): void {
    const channels = this.#channels.channels;
    const pose = this.#pose;
    pose.set(this.#rest);
    for (const layer of this.#layers) layerInternals.blend(layer, pose, channels, this.#target);
    for (let i = 0; i < channels.length; i++) this.#channels.write(channels[i] as Channel, pose);
  }

  /** Compiles `motion` once (again if a node of it was destroyed) and gives a new playing state. */
  #playingOf(motion: Motion): Playing {
    let compiled = this.#compiled.get(motion);
    if (!compiled || compiled.tracks.some((track) => track.channel.node.destroyed)) {
      const before = this.#channels.channels.length;
      try {
        compiled = compileMotion(motion, this.scene, this.#channels);
      } finally {
        // Channels of the tracks compiled before a failing one stay in the set: they need
        // rest values too.
        this.#grow(before);
      }
      this.#compiled.set(motion, compiled);
    }
    const size = this.#channels.size;
    const playing: Playing = {
      compiled,
      time: 0,
      sample: new Float64Array(size),
      reference: new Float64Array(size),
      touched: new Uint8Array(this.#channels.channels.length),
    };
    compiled.sample(0, playing.reference);
    return playing;
  }

  /** Grows buffers for channels added from index `from`, reading their rest values. */
  #grow(from: number): void {
    const set = this.#channels;
    if (set.channels.length === from) return;
    const size = set.size;
    const rest = new Float64Array(size);
    rest.set(this.#rest);
    for (let i = from; i < set.channels.length; i++) set.read(set.channels[i] as Channel, rest);
    this.#rest = rest;
    this.#pose = new Float64Array(size);
    this.#target = new Float64Array(size);
  }

  static {
    animatorInternals = {
      playing: (animator, motion) => animator.#playingOf(motion),
      scene: (animator) => animator.scene,
    };
  }
}
