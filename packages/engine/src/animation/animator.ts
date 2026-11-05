import type { Node } from '../scene/node.ts';
import type { Scene } from '../scene/scene.ts';
import { addChannel, type Channel, ChannelSet, mixChannel, sampleTracks } from './channels.ts';
import { type Clip, type CompiledClip, clipTime, compileClip } from './clip.ts';

/*
 * Animator: animation layers over one scene. Each frame starts from the rest pose (the
 * values the animated properties had when the animator first saw them), and every layer
 * blends its clip into it in order:
 * - an override layer moves the pose towards its clip by its weight;
 * - an additive layer adds how far its clip is from the clip's first frame, scaled by its
 *   weight (rotations compose).
 * A mask limits a layer to a node and its descendants. Playing a new clip on a layer with
 * a fade crossfades from the previous clip. The result is written to the nodes once.
 *
 * The animator owns every property its clips animate: it writes them every frame, so other
 * code should not set them directly. Properties that no layer touches return to rest.
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
  /** Id of the node whose subtree the layer affects; the whole scene by default. */
  readonly mask?: string | null;
}

export interface PlayOptions {
  /** Crossfade time from the current clip in seconds; 0 switches at once. */
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

/** A clip playing on a layer: its compiled tracks, own time and a sample buffer. */
interface Playing {
  compiled: CompiledClip;
  time: number;
  sample: Float64Array;
  /** The clip's first frame, the reference of additive layers. */
  reference: Float64Array;
  touched: Uint8Array;
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
  const { clip, tracks } = playing.compiled;
  sampleTracks(
    tracks,
    clipTime(clip.duration, clip.loop, playing.time),
    playing.sample,
    playing.touched,
  );
}

/** One animation layer. Created by `Animator.addLayer`. */
export class AnimationLayer {
  readonly name: string;
  readonly mode: BlendMode;
  readonly #animator: Animator;
  #weight: number;
  #mask: string | null;
  #maskFlags: Uint8Array | null = null;
  #current: Playing | null = null;
  #previous: Playing | null = null;
  #fade = 0;
  #fadeElapsed = 0;

  constructor(animator: Animator, options: LayerOptions) {
    this.#animator = animator;
    this.name = options.name ?? '';
    const mode = options.mode ?? 'override';
    if (!(BLEND_MODES as readonly string[]).includes(mode)) {
      throw new RangeError(`Unknown blend mode "${mode}".`);
    }
    this.mode = mode;
    this.#weight = checkWeight(options.weight ?? 1);
    this.#mask = options.mask ?? null;
    if (this.#mask !== null) this.#maskNode();
  }

  get weight(): number {
    return this.#weight;
  }
  set weight(value: number) {
    this.#weight = checkWeight(value);
  }

  /** Id of the masked subtree root, or `null` for the whole scene. */
  get mask(): string | null {
    return this.#mask;
  }
  set mask(id: string | null) {
    this.#mask = id;
    this.#maskFlags = null;
    if (id !== null) this.#maskNode();
  }

  /** The clip playing now, or `null`. */
  get clip(): Clip | null {
    return this.#current?.compiled.clip ?? null;
  }

  /** Time of the current clip in seconds (before its loop mode). Setting it seeks. */
  get time(): number {
    return this.#current?.time ?? 0;
  }
  set time(value: number) {
    if (this.#current) this.#current.time = value;
  }

  /** Whether a crossfade is in progress. */
  get fading(): boolean {
    return this.#previous !== null;
  }

  /**
   * Plays `clip` on this layer. With a `fade`, the previous clip keeps playing and fades
   * out while the new one fades in.
   */
  play(clip: Clip, options: PlayOptions = {}): void {
    const fade = options.fade ?? 0;
    if (!(fade >= 0 && Number.isFinite(fade))) {
      throw new RangeError(`Fade must be a finite non-negative number, got ${fade}.`);
    }
    const playing = animatorInternals.playing(this.#animator, clip);
    playing.time = options.time ?? 0;
    if (fade > 0 && this.#current) {
      this.#previous = this.#current;
      this.#fade = fade;
      this.#fadeElapsed = 0;
    } else {
      this.#previous = null;
    }
    this.#current = playing;
  }

  /** Stops the layer; with a `fade`, its clip fades out first. */
  stop(options: { readonly fade?: number } = {}): void {
    const fade = options.fade ?? 0;
    if (fade > 0 && this.#current) {
      this.#previous = this.#current;
      this.#fade = fade;
      this.#fadeElapsed = 0;
    } else {
      this.#previous = null;
    }
    this.#current = null;
  }

  /** Advances the layer's clips and its crossfade by `dt` seconds. */
  advance(dt: number): void {
    if (this.#current) this.#current.time += dt;
    if (this.#previous) {
      this.#previous.time += dt;
      this.#fadeElapsed += dt;
      if (this.#fadeElapsed >= this.#fade) this.#previous = null;
    }
  }

  #maskNode(): Node {
    const scene = animatorInternals.scene(this.#animator);
    const node = this.#mask === null ? null : scene.getById(this.#mask);
    if (!node) throw new Error(`Layer mask: no node with id "${this.#mask}" in the scene.`);
    return node;
  }

  /** 1 for channels inside the mask, 0 outside; recomputed when channels are added. */
  #flags(channels: readonly Channel[]): Uint8Array | null {
    if (this.#mask === null) return null;
    let flags = this.#maskFlags;
    if (!flags || flags.length !== channels.length) {
      const root = this.#maskNode();
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

  /** Blends this layer into `pose`. */
  blend(pose: Float64Array, channels: readonly Channel[], scratch: Float64Array): void {
    const current = this.#current;
    const previous = this.#previous;
    if ((!current && !previous) || this.#weight === 0) return;
    const mask = this.#flags(channels);
    const f = previous ? Math.min(1, this.#fadeElapsed / this.#fade) : 1;
    if (current) samplePlaying(current, pose.length, channels.length);
    if (previous) samplePlaying(previous, pose.length, channels.length);
    const weight = this.#weight;
    for (let i = 0; i < channels.length; i++) {
      if (mask && mask[i] === 0) continue;
      const channel = channels[i] as Channel;
      const inCurrent = current !== null && current.touched[i] === 1;
      const inPrevious = previous !== null && previous.touched[i] === 1;
      if (!inCurrent && !inPrevious) continue;
      if (this.mode === 'override') {
        if (inCurrent && inPrevious) {
          // Crossfade target first, then towards it by the layer weight.
          mixChannel(
            channel,
            scratch,
            (previous as Playing).sample,
            (current as Playing).sample,
            f,
          );
          mixChannel(channel, pose, pose, scratch, weight);
        } else if (inCurrent) {
          mixChannel(channel, pose, pose, (current as Playing).sample, weight * f);
        } else {
          mixChannel(channel, pose, pose, (previous as Playing).sample, weight * (1 - f));
        }
      } else {
        if (inPrevious) {
          const p = previous as Playing;
          addChannel(channel, pose, p.sample, p.reference, weight * (1 - f));
        }
        if (inCurrent) {
          const c = current as Playing;
          addChannel(channel, pose, c.sample, c.reference, weight * f);
        }
      }
    }
  }
}

let animatorInternals!: {
  playing(animator: Animator, clip: Clip): Playing;
  scene(animator: Animator): Scene;
};

/** Animation layers over one scene. Call `update(dt)` once per frame. */
export class Animator {
  readonly scene: Scene;
  readonly #channels = new ChannelSet();
  readonly #layers: AnimationLayer[] = [];
  readonly #compiled = new Map<Clip, CompiledClip>();
  #rest = new Float64Array(0);
  #pose = new Float64Array(0);
  #scratch = new Float64Array(0);

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

  /** The layer named `name`, or `null`. */
  layer(name: string): AnimationLayer | null {
    return this.#layers.find((layer) => layer.name === name) ?? null;
  }

  /** Advances every layer by `dt` seconds and writes the blended pose to the nodes. */
  update(dt: number): void {
    for (const layer of this.#layers) layer.advance(dt);
    this.evaluate();
  }

  /**
   * Writes the blended pose for the layers' current times without advancing them: after
   * setting layer times, this gives the same frame as playing up to them.
   */
  evaluate(): void {
    const channels = this.#channels.channels;
    const pose = this.#pose;
    pose.set(this.#rest);
    for (const layer of this.#layers) layer.blend(pose, channels, this.#scratch);
    for (let i = 0; i < channels.length; i++) this.#channels.write(channels[i] as Channel, pose);
  }

  /** Compiles `clip` once and gives a fresh playing state for it. */
  #playingOf(clip: Clip): Playing {
    let compiled = this.#compiled.get(clip);
    if (!compiled) {
      const before = this.#channels.channels.length;
      compiled = compileClip(clip, this.scene, this.#channels);
      this.#compiled.set(clip, compiled);
      this.#grow(before);
    }
    const size = this.#channels.size;
    const playing: Playing = {
      compiled,
      time: 0,
      sample: new Float64Array(size),
      reference: new Float64Array(size),
      touched: new Uint8Array(this.#channels.channels.length),
    };
    sampleTracks(compiled.tracks, 0, playing.reference);
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
    this.#scratch = new Float64Array(size);
  }

  static {
    animatorInternals = {
      playing: (animator, clip) => animator.#playingOf(clip),
      scene: (animator) => animator.scene,
    };
  }
}
