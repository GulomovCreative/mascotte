import { describe, it } from 'vitest';
import { euler, quat, vec3 } from '../src/index.ts';
import { expectClose, random, range } from './helpers.ts';
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('rotations');

/*
 * Zdog rotates a vector first about Z, then about Y, then about X,
 * but its rotation about Y has the opposite sign. So Zdog's `rotate` matches
 * order 'XYZ' with angle `-y`. This matters when porting scenes and comparing against snapshots.
 */
describe('rotation compatibility with Zdog', () => {
  it("Zdog rotate {x, y, z} = fromEuler {x, -y, z, 'XYZ'}", () => {
    const next = random(7);
    for (let i = 0; i < 200; i++) {
      const rotation = {
        x: range(next, -Math.PI, Math.PI),
        y: range(next, -Math.PI, Math.PI),
        z: range(next, -Math.PI, Math.PI),
      };
      const point = { x: range(next, -20, 20), y: range(next, -20, 20), z: range(next, -20, 20) };

      const expected = zdog.next<{ x: number; y: number; z: number }>('rotate', {
        point,
        rotation,
      });

      const q = quat.fromEuler(quat.create(), euler.create(rotation.x, -rotation.y, rotation.z));
      const ours = quat.transformVec3(vec3.create(), q, point);
      expectClose(ours, expected);
    }
  });
});
