import {
  lookupTarget,
  type Rig,
  resolveTarget,
  type Target,
  type TargetScope,
  targetName,
} from '../rig/rig.ts';
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
import { applySpring, bindSpring, Spring, type SpringOptions, stepSpring } from './springs.ts';

/*
 * Animator: animation layers over one scene. A layer plays motions: keyed clips or sets of
 * procedural behaviors (see behaviors.ts); in this file, "clip" stands for either. Every
 * property animated by a clip played on the animator, or turned by a spring, becomes a
 * channel; its value when it first becomes one is its rest pose, and it is not updated later
 * (a behavior's `from` is not the rest pose: an override layer below full weight blends it
 * with rest). Each frame starts from the rest pose, and every layer blends its clips into it
 * in order:
 * - an override layer moves the pose towards its clips by its weight;
 * - an additive layer adds how far its clips are from their value at time 0, scaled by its
 *   weight (rotations compose). Booleans, enums and `null` colors are not additive.
 * A mask limits a layer to a node and its descendants. Clips, behaviors, masks and springs
 * address nodes by id or by a slot of the animator's rig (see rig.ts). Playing a clip with a
 * fade fades it in over what the layer showed before, even in the middle of another fade.
 * The result is written to the nodes once per frame.
 *
 * The animator owns every property any of its clips has animated, for its whole lifetime: it
 * writes them every frame, so other code should not set them directly, and properties that no
 * layer animates at the moment return to rest. A motion is compiled once per object, so an
 * edited one must be a new object. It is compiled again the next time it is played after one
 * of its nodes was destroyed or the rig's slots changed (`Rig.version`); until then a playing
 * motion keeps the nodes it was compiled for, and nodes it no longer animates return to rest.
 *
 * Springs (see springs.ts) run after the layers: each frame they turn their nodes from the
 * blended pose, parents before children (ordered by the current hierarchy every frame). The
 * animator owns the rotation of a spring's node like an animated property, so the spring's
 * turn does not build up from frame to frame. A spring whose node was destroyed moves to the
 * node its target resolves to now (the one that replaced it under the same id, or the one
 * its slot is bound to), if any, and starts there at rest. Rebinding a slot alone does not
 * move a spring whose node is still there.
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
   * The node whose subtree the layer affects, by id or rig slot; the whole scene by default.
   * Membership is taken from the hierarchy when the mask is set, when clips add channels and
   * when the rig's slots change; after reparenting nodes, assign `layer.mask` again to refresh
   * it. A mask that no longer resolves to a node (a destroyed node, a removed slot) lets the
   * layer affect nothing.
   */
  readonly mask?: Target | null;
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

/** A motion compiled against the animator's scene, rig and channels. */
interface CompiledMotion {
  readonly motion: Motion;
  /** `Rig.version` when compiled, -1 without a rig. */
  readonly rigVersion: number;
  readonly tracks: readonly SampledTrack[];
  /** Samples the motion at `time` (seconds, before a clip's loop mode). */
  sample(time: number, out: Float64Array, touched?: Uint8Array): void;
}

function compileMotion(motion: Motion, scope: TargetScope, channels: ChannelSet): CompiledMotion {
  const rigVersion = scope.rig?.version ?? -1;
  if ('behaviors' in motion) {
    const compiled = compileBehaviors(motion, scope, channels);
    return {
      motion,
      rigVersion,
      tracks: compiled.tracks,
      sample: (time, out, touched) => sampleBehaviors(compiled, time, out, touched),
    };
  }
  const { tracks } = compileClip(motion, scope, channels);
  const { duration, loop } = motion;
  return {
    motion,
    rigVersion,
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
  #mask: Target | null;
  #maskFlags: Uint8Array | null = null;
  /** `Rig.version` when the mask flags were computed. */
  #maskRigVersion = -1;
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

  /**
   * The masked subtree root (an id or a rig slot), or `null` for the whole scene. Throws for a
   * target that does not resolve to a node now; one that stops resolving later masks
   * everything out.
   */
  get mask(): Target | null {
    return this.#mask;
  }
  set mask(target: Target | null) {
    if (target !== null) this.#maskNode(target);
    this.#mask = target;
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

  #maskNode(target: Target): Node {
    const node = lookupTarget(target, this.#animator);
    if (typeof node === 'string') throw new Error(`Layer mask ${targetName(target)}: ${node}`);
    return node;
  }

  /**
   * 1 for channels inside the mask, 0 outside (all 0 when the mask no longer resolves);
   * recomputed when channels are added or the rig's slots change.
   */
  #flags(channels: readonly Channel[]): Uint8Array | null {
    if (this.#mask === null) return null;
    let flags = this.#maskFlags;
    const animator = this.#animator;
    const version = animator.rig?.version ?? -1;
    if (!flags || flags.length !== channels.length || this.#maskRigVersion !== version) {
      const root = resolveTarget(this.#mask, animator);
      this.#maskRigVersion = version;
      flags = new Uint8Array(channels.length);
      for (let i = 0; root && i < channels.length; i++) {
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
};

export interface AnimatorOptions {
  /**
   * The rig that resolves slot targets of clips, behaviors, masks and springs; without one, a
   * slot target is an error.
   */
  readonly rig?: Rig | null;
}

/** Animation layers over one scene. Call `update(dt)` once per frame. */
export class Animator implements TargetScope {
  readonly scene: Scene;
  readonly rig: Rig | null;
  readonly #channels = new ChannelSet();
  readonly #layers: AnimationLayer[] = [];
  readonly #compiled = new Map<Motion, CompiledMotion>();
  readonly #springs: Spring[] = [];
  #springsEnabled = true;
  #rest = new Float64Array(0);
  #pose = new Float64Array(0);
  /** The layer target while a layer blends. */
  #target = new Float64Array(0);

  constructor(scene: Scene, options: AnimatorOptions = {}) {
    this.scene = scene;
    this.rig = options.rig ?? null;
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

  /** Springs in the order they ran in the last frame: parents before children. */
  get springs(): readonly Spring[] {
    return this.#springs;
  }

  /**
   * Adds a spring on the node `options.target` (an id or a rig slot, resolved now). Throws for
   * a target that does not resolve to a node, for a node that already has a spring and for
   * invalid parameters (RangeError). From now on the animator writes the node's rotation every
   * frame, so other code should not set it: the spring turns the node from its blended pose,
   * which is the rotation the node had when the spring was added unless a clip animates it.
   */
  addSpring(options: SpringOptions): Spring {
    const name = targetName(options.target);
    const node = lookupTarget(options.target, this);
    if (typeof node === 'string') throw new Error(`Spring ${name}: ${node}`);
    if (this.#springs.some((spring) => spring.node === node)) {
      throw new Error(`Spring ${name}: the node already has a spring.`);
    }
    const spring = new Spring(node, options);
    this.#own(node);
    this.#springs.push(spring);
    this.#sortSprings();
    return spring;
  }

  /**
   * Removes `spring` (nothing happens for a spring not on this animator). From the next frame
   * its node shows the plain pose; the animator still owns the node's rotation.
   */
  removeSpring(spring: Spring): void {
    const index = this.#springs.indexOf(spring);
    if (index >= 0) this.#springs.splice(index, 1);
  }

  /** Makes the rotation of `node` a channel, reading its rest value. */
  #own(node: Node): void {
    const rotation = findProperty(node, 'rotation');
    if (!rotation) throw new Error(`Spring ${node.id}: the node has no rotation.`);
    const before = this.#channels.channels.length;
    this.#channels.channel(node, rotation);
    this.#grow(before);
  }

  /** Moves springs off destroyed nodes and puts parents before children. */
  #prepareSprings(): void {
    const springs = this.#springs;
    for (let i = 0; i < springs.length; i++) {
      const spring = springs[i] as Spring;
      if (!spring.node.destroyed) continue;
      const node = resolveTarget(spring.target, this);
      if (!node || springs.some((other) => other.node === node)) continue;
      this.#own(node);
      bindSpring(spring, node);
    }
    this.#sortSprings();
  }

  /** Stable insertion sort by depth: the hierarchy may have changed since the last frame. */
  #sortSprings(): void {
    const springs = this.#springs;
    for (let i = 1; i < springs.length; i++) {
      const spring = springs[i] as Spring;
      const depth = depthOf(spring.node);
      let j = i;
      while (j > 0 && depthOf((springs[j - 1] as Spring).node) > depth) {
        springs[j] = springs[j - 1] as Spring;
        j--;
      }
      springs[j] = spring;
    }
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
   * Puts every spring at rest: on the next frame each tip is where the pose puts it. To see
   * springs at a sought time, set the layer times to where playback started, reset the
   * springs and replay the same `update(dt)` steps (each at most `SPRING_MAX_DT`): from rest,
   * the same steps over the same poses give the same motion.
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
    if (this.#springsEnabled) this.#prepareSprings();
    this.#writePose();
    if (!this.#springsEnabled) return;
    for (const spring of this.#springs) {
      stepSpring(spring, dt);
      applySpring(spring);
    }
  }

  /**
   * Writes the blended pose for the layers' current times without advancing them, with the
   * springs in their current state (after `resetSprings`, the plain pose). Outside fades and
   * with springs off, setting layer times and evaluating gives the same frame as playing up
   * to them; fade progress and spring motion are not seekable.
   */
  evaluate(): void {
    if (this.#springsEnabled) this.#prepareSprings();
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

  /**
   * Compiles `motion` once (again if a node of it was destroyed or the rig's slots changed)
   * and gives a new playing state.
   */
  #playingOf(motion: Motion): Playing {
    let compiled = this.#compiled.get(motion);
    if (
      !compiled ||
      compiled.rigVersion !== (this.rig?.version ?? -1) ||
      compiled.tracks.some((track) => track.channel.node.destroyed)
    ) {
      const before = this.#channels.channels.length;
      try {
        compiled = compileMotion(motion, this, this.#channels);
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
    };
  }
}
