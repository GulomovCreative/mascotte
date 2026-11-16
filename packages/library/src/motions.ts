import type { BehaviorSet, BlendMode, Clip, Motion, Target } from '@mascotte/engine';
import { euler, quat } from '@mascotte/math';

/**
 * A motion of the library: written for archetype slots only, so it fits any mascot whose rig
 * binds them. Positions are in sizes of the mascot (see `Archetype.size`); `scaleMotion`
 * turns them into scene units. `layer` is the kind of layer it is written for, which a document
 * must play it on: an additive motion moves from wherever the pose is (a hop, a breath), an
 * override one sets the pose. Booleans (visibility) are not additive, so a motion that switches
 * them (a blink) is for an override layer.
 */
export interface LibraryMotion {
  readonly name: string;
  readonly description: string;
  readonly layer: BlendMode;
  readonly motion: Motion;
}

function rotation(x: number, y: number, z: number) {
  const q = quat.fromEuler(quat.create(), euler.create(x, y, z));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

const still = rotation(0, 0, 0);
const one = { x: 1, y: 1, z: 1 };
const zero = { x: 0, y: 0, z: 0 };

const breathe: BehaviorSet = {
  behaviors: [
    {
      kind: 'oscillate',
      target: { slot: 'body' },
      property: 'scale',
      from: one,
      to: { x: 1.03, y: 1.05, z: 1.03 },
      period: 3,
    },
  ],
};

const blink: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'eyes' },
      property: 'visible',
      from: true,
      to: false,
      duration: 0.16,
      minInterval: 1.8,
      maxInterval: 4.5,
      seed: 3,
    },
    {
      kind: 'blink',
      target: { slot: 'lids' },
      property: 'visible',
      from: false,
      to: true,
      duration: 0.16,
      minInterval: 1.8,
      maxInterval: 4.5,
      seed: 3,
    },
  ],
};

const hop: Clip = {
  duration: 0.5,
  loop: 'once',
  tracks: [
    {
      target: { slot: 'root' },
      property: 'position',
      keys: [
        { time: 0, value: zero, easing: 'quadOut' },
        { time: 0.25, value: { x: 0, y: -0.2, z: 0 }, easing: 'quadIn' },
        { time: 0.5, value: zero },
      ],
    },
  ],
};

const bob: BehaviorSet = {
  behaviors: [
    {
      kind: 'oscillate',
      target: { slot: 'root' },
      property: 'position',
      from: zero,
      to: { x: 0, y: -0.02, z: 0 },
      period: 3,
    },
  ],
};

const sway: BehaviorSet = {
  behaviors: [
    {
      kind: 'noise',
      target: { slot: 'head' },
      property: 'rotation',
      from: rotation(0.05, -0.2, -0.06),
      to: rotation(-0.05, 0.2, 0.06),
      frequency: 0.5,
      seed: 5,
    },
  ],
};

const tilt: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'head' },
      property: 'rotation',
      from: still,
      to: rotation(0.08, 0, -0.25),
      duration: 0.9,
      minInterval: 2.5,
      maxInterval: 5,
      seed: 21,
    },
  ],
};

const wave: Clip = {
  duration: 1.2,
  loop: 'pingpong',
  tracks: [
    {
      target: { slot: 'arm.R' },
      property: 'rotation',
      keys: [
        { time: 0, value: rotation(0, 0, -1.9), easing: 'sineInOut' },
        { time: 1.2, value: rotation(0, 0, -2.6) },
      ],
    },
  ],
};

/** Both wings (the left one turns the other way) between two angles out from the body. */
function wings(from: number, to: number): Clip['tracks'] {
  return [-1, 1].map((side) => ({
    target: { slot: side < 0 ? 'wing.L' : 'wing.R' },
    property: 'rotation',
    keys: [
      { time: 0, value: rotation(0, 0, -side * from), easing: 'sineInOut' as const },
      { time: 0.24, value: rotation(0, 0, -side * to) },
    ],
  }));
}

const flap: Clip = { duration: 0.24, loop: 'pingpong', tracks: wings(0.8, 1.4) };

const chirp: BehaviorSet = {
  behaviors: [
    {
      kind: 'blink',
      target: { slot: 'beak.lower' },
      property: 'rotation',
      from: still,
      to: rotation(-0.45, 0, 0),
      duration: 0.3,
      minInterval: 3,
      maxInterval: 6,
      seed: 13,
    },
  ],
};

const wag: BehaviorSet = {
  behaviors: [
    {
      kind: 'oscillate',
      target: { slot: 'tail' },
      property: 'rotation',
      from: rotation(0, 0, -0.4),
      to: rotation(0, 0, 0.4),
      period: 0.6,
    },
  ],
};

/** The library, by name. */
export const MOTIONS: ReadonlyMap<string, LibraryMotion> = new Map(
  (
    [
      {
        name: 'breathe',
        description: 'The body swells and settles.',
        layer: 'additive',
        motion: breathe,
      },
      {
        name: 'blink',
        description: 'The eyes close for a moment now and then.',
        layer: 'override',
        motion: blink,
      },
      {
        name: 'hop',
        description: 'One hop, a fifth of its size (root to head or eyes) high.',
        layer: 'additive',
        motion: hop,
      },
      {
        name: 'bob',
        description: 'A slow, slight bob up and down.',
        layer: 'additive',
        motion: bob,
      },
      { name: 'sway', description: 'The head wanders a little.', layer: 'additive', motion: sway },
      {
        name: 'tilt',
        description: 'Now and then a quick tilt of the head.',
        layer: 'additive',
        motion: tilt,
      },
      {
        name: 'wave',
        description: 'The right arm goes up and waves.',
        layer: 'override',
        motion: wave,
      },
      { name: 'flap', description: 'Both wings flap, raised.', layer: 'override', motion: flap },
      {
        name: 'chirp',
        description: 'Now and then the beak opens.',
        layer: 'additive',
        motion: chirp,
      },
      { name: 'wag', description: 'The tail wags.', layer: 'additive', motion: wag },
    ] satisfies LibraryMotion[]
  ).map((motion) => [motion.name, motion]),
);

/** The slots a motion addresses, in the order it first does; node ids are not slots. */
export function slotsOf(motion: Motion): string[] {
  const slots = new Set<string>();
  const add = (target: Target) => {
    if (typeof target !== 'string') slots.add(target.slot);
  };
  if ('tracks' in motion) for (const track of motion.tracks) add(track.target);
  else if ('behaviors' in motion) for (const behavior of motion.behaviors) add(behavior.target);
  else for (const point of motion.blend) for (const slot of slotsOf(point.motion)) slots.add(slot);
  return [...slots];
}

function scaleValue(value: unknown, size: number): unknown {
  const v = value as { x: number; y: number; z: number };
  return { x: v.x * size, y: v.y * size, z: v.z * size };
}

/**
 * A copy of a library motion with its positions (written in sizes) in scene units: every
 * `position` value is multiplied by `size`. Rotations, scales and the rest keep their values.
 */
export function scaleMotion(motion: Motion, size: number): Motion {
  if ('tracks' in motion) {
    return {
      ...motion,
      tracks: motion.tracks.map((track) =>
        track.property === 'position'
          ? {
              ...track,
              keys: track.keys.map((key) => ({ ...key, value: scaleValue(key.value, size) })),
            }
          : track,
      ),
    } as Clip;
  }
  if ('behaviors' in motion) {
    return {
      ...motion,
      behaviors: motion.behaviors.map((behavior) =>
        behavior.property === 'position'
          ? {
              ...behavior,
              from: scaleValue(behavior.from, size),
              to: scaleValue(behavior.to, size),
            }
          : behavior,
      ),
    } as BehaviorSet;
  }
  return {
    ...motion,
    blend: motion.blend.map((point) => ({ ...point, motion: scaleMotion(point.motion, size) })),
  } as Motion;
}

/** Whether a motion moves positions, which `scaleMotion` needs a mascot's size for. */
export function usesSize(motion: Motion): boolean {
  if ('tracks' in motion) return motion.tracks.some((track) => track.property === 'position');
  if ('behaviors' in motion) {
    return motion.behaviors.some((behavior) => behavior.property === 'position');
  }
  return motion.blend.some((point) => usesSize(point.motion));
}
