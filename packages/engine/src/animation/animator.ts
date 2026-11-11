import {
  applyConstraint,
  type Constraint,
  type ConstraintOf,
  type ConstraintSpec,
  createConstraint,
  rebindConstraint,
  writtenBy,
} from '../rig/constraints.ts';
import {
  copyTarget,
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
 * A mask limits a layer to a node and its descendants. Clips, behaviors, masks, constraints
 * and springs address nodes by id or by a slot of the animator's rig (see rig.ts). Playing a
 * clip with a fade fades it in over what the layer showed before, even in the middle of
 * another fade. The result is written to the nodes once per frame.
 *
 * The animator owns every property any of its clips has animated, for its whole lifetime: it
 * writes them every frame, so other code should not set them directly, and properties that no
 * layer animates at the moment return to rest. A motion is compiled once per object, so an
 * edited one must be a new object. It is compiled again the next time it is played after one
 * of its nodes was destroyed or the rig's slots changed (`Rig.version`); until then a playing
 * motion keeps the nodes it was compiled for, and nodes it no longer animates return to rest.
 *
 * Constraints (see rig/constraints.ts) run after the layers, in the order of
 * `animator.constraints`, and adjust the blended pose: aim, look at, two-bone IK, copy and
 * limit. The animator owns the properties they write, like animated ones.
 *
 * Springs (see springs.ts) run after the layers and constraints: each frame they turn their
 * nodes from the pose so far, parents before children (ordered by the current hierarchy every
 * frame). The animator owns the rotation of a spring's node like an animated property, so the
 * spring's turn does not build up from frame to frame. A spring whose node was destroyed
 * moves to the node its target resolves to now (the one that replaced it under the same id,
 * or the one its slot is bound to), if any, and starts there at rest. Rebinding a slot alone
 * does not move a spring whose node is still there. Constraints move the same way when any
 * of their nodes is gone or their nodes no longer hold together (they keep no state, so there
 * is nothing to reset).
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
   * The target is resolved when the mask is set and whenever the layer plays a motion, like the
   * motion's own targets, so after the rig's slots change the mask moves together with the
   * motions on their next `play`. Membership is taken from the hierarchy when the mask is
   * resolved and when clips add channels; after reparenting nodes, assign `layer.mask` again
   * to refresh it. While the masked node is destroyed, the layer affects nothing.
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

function checkIndex(index: number, last: number): void {
  if (!(Number.isInteger(index) && index >= 0 && index <= last)) {
    throw new RangeError(
      `Constraint index must be an integer from 0 to ${last}, got ${String(index)}.`,
    );
  }
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

/** `Rig.version` of `rig`, or -1 without a rig. */
function rigVersionOf(rig: Rig | null): number {
  return rig ? rig.version : -1;
}

function compileMotion(motion: Motion, scope: TargetScope, channels: ChannelSet): CompiledMotion {
  const rigVersion = rigVersionOf(scope.rig);
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
  #mask: Target | null = null;
  /** The node the mask resolved to last. */
  #maskRoot: Node | null = null;
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
    this.mask = options.mask ?? null;
  }

  get weight(): number {
    return this.#weight;
  }
  set weight(value: number) {
    this.#weight = checkWeight(value);
  }

  /**
   * The masked subtree root (an id or a rig slot, as a copy), or `null` for the whole scene.
   * Throws for a target that does not resolve to a node.
   */
  get mask(): Target | null {
    return this.#mask;
  }
  set mask(target: Target | null) {
    this.#maskRoot = target === null ? null : this.#maskNode(target);
    this.#mask = target === null ? null : copyTarget(target);
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
    // The mask is resolved again with the motion's targets, and kept if either fails.
    const root = this.#mask === null ? null : this.#maskNode(this.#mask);
    const playing = animatorInternals.playing(this.#animator, motion);
    if (root !== this.#maskRoot) {
      this.#maskRoot = root;
      this.#maskFlags = null;
    }
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
   * 1 for channels inside the mask, 0 outside; recomputed when the mask is resolved to another
   * node and when channels are added.
   */
  #flags(channels: readonly Channel[]): Uint8Array | null {
    const root = this.#maskRoot;
    if (root === null) return null;
    let flags = this.#maskFlags;
    if (!flags || flags.length !== channels.length) {
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
};

export interface AnimatorOptions {
  /**
   * The rig that resolves slot targets of clips, behaviors, masks and springs; without one, a
   * slot target is an error. Its root may join the scene later; slots resolve once it has.
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
  readonly #constraints: Constraint[] = [];
  /** `Scene.structureVersion` and `Rig.version` when springs last looked for replacements. */
  #rebindStructure = -1;
  #rebindRig = -1;
  /** The same versions when constraints last looked for replacements. */
  #constraintStructure = -1;
  #constraintRig = -1;
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
   * frame, so other code should not set it: the spring turns the node from the pose after the
   * layers and constraints, which is the rotation the node had when the spring was added
   * unless a clip or a constraint changes it.
   */
  addSpring(options: SpringOptions): Spring {
    const name = targetName(options.target);
    const node = lookupTarget(options.target, this);
    if (typeof node === 'string') throw new Error(`Spring ${name}: ${node}`);
    if (this.#springs.some((spring) => spring.node === node)) {
      throw new Error(`Spring ${name}: the node already has a spring.`);
    }
    const spring = new Spring(node, options);
    this.#own(node, `Spring ${name}`);
    this.#springs.push(spring);
    this.#sortSprings();
    return spring;
  }

  /**
   * Removes `spring`; whether it was on this animator. From the next frame its node shows the
   * plain pose; the animator still owns the node's rotation.
   */
  removeSpring(spring: Spring): boolean {
    const index = this.#springs.indexOf(spring);
    if (index >= 0) this.#springs.splice(index, 1);
    return index >= 0;
  }

  /**
   * Makes property `name` of `node` a channel, reading its rest value; `owner` names what
   * needs it in the error for a node without it.
   */
  #own(node: Node, owner: string, name = 'rotation'): void {
    const property = findProperty(node, name);
    if (!property) throw new Error(`${owner}: the node has no ${name}.`);
    const before = this.#channels.channels.length;
    this.#channels.channel(node, property);
    this.#grow(before);
  }

  /** Constraints in evaluation order. */
  get constraints(): readonly Constraint[] {
    return this.#constraints;
  }

  /**
   * Adds a constraint from `spec` at `index` of the evaluation order (the end by default) and
   * returns it. Its targets are resolved now (ids or rig slots). Throws a RangeError for an
   * index out of range, the errors of `createConstraint` (in rig/constraints.ts) for a spec
   * that is not valid or does not resolve, and an Error for a node without a property the
   * constraint writes; then nothing changes. From now on the animator owns the properties the
   * constraint writes, like a spring's rotation.
   */
  addConstraint<S extends ConstraintSpec>(
    spec: S,
    index = this.#constraints.length,
  ): ConstraintOf<S> {
    checkIndex(index, this.#constraints.length);
    const constraint = createConstraint(spec, this);
    this.#ownWritten(constraint);
    this.#constraints.splice(index, 0, constraint);
    return constraint as ConstraintOf<S>;
  }

  /**
   * Owns the properties `constraint` writes, checking them all before owning any. Every node
   * has position, rotation and scale, so after a rebind (mid-frame) this cannot throw.
   */
  #ownWritten(constraint: Constraint): void {
    const written = writtenBy(constraint);
    const owner = `Constraint ${constraint.kind} ${targetName(constraint.target)}`;
    for (const { node, property } of written) {
      if (!findProperty(node, property)) throw new Error(`${owner}: the node has no ${property}.`);
    }
    for (const { node, property } of written) this.#own(node, owner, property);
  }

  /**
   * Removes `constraint`; whether it was on this animator. From the next frame its nodes show
   * the pose; the animator still owns their properties.
   */
  removeConstraint(constraint: Constraint): boolean {
    const index = this.#constraints.indexOf(constraint);
    if (index >= 0) this.#constraints.splice(index, 1);
    return index >= 0;
  }

  /**
   * Replaces `constraint` with a new one made from `spec`, at the same place in the order, and
   * returns it: how an edited spec takes effect. Throws like `addConstraint`, and for a
   * constraint not on this animator; then nothing changes.
   */
  replaceConstraint<S extends ConstraintSpec>(constraint: Constraint, spec: S): ConstraintOf<S> {
    const index = this.#constraints.indexOf(constraint);
    if (index < 0) throw new Error('The constraint is not on this animator.');
    const replacement = createConstraint(spec, this);
    this.#ownWritten(replacement);
    this.#constraints[index] = replacement;
    return replacement as ConstraintOf<S>;
  }

  /**
   * Moves `constraint` to `index` of the evaluation order. Throws an Error for one not on this
   * animator and a RangeError for an index out of range.
   */
  moveConstraint(constraint: Constraint, index: number): void {
    const from = this.#constraints.indexOf(constraint);
    if (from < 0) throw new Error('The constraint is not on this animator.');
    checkIndex(index, this.#constraints.length - 1);
    this.#constraints.splice(from, 1);
    this.#constraints.splice(index, 0, constraint);
  }

  /**
   * Moves springs off destroyed nodes and puts parents before children. A replacement can only
   * appear with a change of the tree or of the slots, so it is looked for only then; a spring
   * that finds none stays on its destroyed node and does nothing.
   */
  #prepareSprings(): void {
    const structure = this.scene.structureVersion;
    const rig = rigVersionOf(this.rig);
    if (structure !== this.#rebindStructure || rig !== this.#rebindRig) {
      this.#rebindStructure = structure;
      this.#rebindRig = rig;
      this.#rebindSprings();
    }
    this.#sortSprings();
  }

  /**
   * Moves constraints whose nodes are gone or no longer hold together to the nodes their
   * targets name now, after a change of the tree or of the slots (the only times one can
   * appear).
   */
  #prepareConstraints(): void {
    const structure = this.scene.structureVersion;
    const rig = rigVersionOf(this.rig);
    if (structure === this.#constraintStructure && rig === this.#constraintRig) return;
    this.#constraintStructure = structure;
    this.#constraintRig = rig;
    const constraints = this.#constraints;
    for (let i = 0; i < constraints.length; i++) {
      const constraint = constraints[i] as Constraint;
      if (rebindConstraint(constraint, this)) this.#ownWritten(constraint);
    }
  }

  #rebindSprings(): void {
    const springs = this.#springs;
    for (let i = 0; i < springs.length; i++) {
      const spring = springs[i] as Spring;
      if (!spring.node.destroyed) continue;
      const node = resolveTarget(spring.target, this);
      if (!node || !findProperty(node, 'rotation')) continue;
      if (springs.some((other) => other.node === node)) continue;
      this.#own(node, `Spring ${targetName(spring.target)}`);
      bindSpring(spring, node);
    }
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
   * Advances every layer by `dt` seconds, writes the blended pose to the nodes, applies the
   * constraints and simulates the springs for `dt` from the result.
   */
  update(dt: number): void {
    checkTime(dt, 'Animator dt');
    for (const layer of this.#layers) layerInternals.advance(layer, dt);
    if (this.#springsEnabled) this.#prepareSprings();
    this.#prepareConstraints();
    this.#writePose();
    this.#applyConstraints();
    if (!this.#springsEnabled) return;
    for (const spring of this.#springs) {
      stepSpring(spring, dt);
      applySpring(spring);
    }
  }

  /**
   * Writes the blended pose for the layers' current times without advancing them, applies the
   * constraints, and shows the springs in their current state (after `resetSprings`, the plain
   * pose). Outside fades, with springs off and the same constraint settings (`point`,
   * `weight`, `enabled`), setting layer times and evaluating gives the same frame as playing
   * up to them; fade progress and spring motion are not seekable.
   */
  evaluate(): void {
    if (this.#springsEnabled) this.#prepareSprings();
    this.#prepareConstraints();
    this.#writePose();
    this.#applyConstraints();
    if (!this.#springsEnabled) return;
    for (const spring of this.#springs) applySpring(spring);
  }

  #applyConstraints(): void {
    const constraints = this.#constraints;
    for (let i = 0; i < constraints.length; i++) applyConstraint(constraints[i] as Constraint);
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
      compiled.rigVersion !== rigVersionOf(this.rig) ||
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
