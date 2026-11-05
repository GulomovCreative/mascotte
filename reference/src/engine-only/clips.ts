import type { Clip } from '@mascotte/engine';
import { euler, quat } from '@mascotte/math';

function turn(y: number) {
  const q = quat.fromEuler(quat.create(), euler.create(0, y, 0));
  return { x: q.x, y: q.y, z: q.z, w: q.w };
}

/**
 * A clip for the 3D mascot scene (`engine-mascot-3d`): the head looks left and right,
 * bobs up and down and its color shifts slightly. Plays back and forth.
 */
export const lookAroundClip: Clip = {
  duration: 2,
  loop: 'pingpong',
  tracks: [
    {
      target: 'head',
      property: 'rotation',
      keys: [
        { time: 0, value: turn(-0.9), easing: 'sineInOut' },
        { time: 2, value: turn(0.9) },
      ],
    },
    {
      target: 'head',
      property: 'position',
      keys: [
        { time: 0, value: { x: 0, y: 0, z: 0 }, easing: 'quadOut' },
        { time: 0.5, value: { x: 0, y: -6, z: 0 }, easing: 'quadIn' },
        { time: 1, value: { x: 0, y: 0, z: 0 }, easing: 'quadOut' },
        { time: 1.5, value: { x: 0, y: -6, z: 0 }, easing: 'quadIn' },
        { time: 2, value: { x: 0, y: 0, z: 0 } },
      ],
    },
    {
      target: 'head',
      property: 'style.color',
      keys: [
        { time: 0, value: '#f6a623', easing: 'sineInOut' },
        { time: 2, value: '#f7c14a' },
      ],
    },
  ],
};
