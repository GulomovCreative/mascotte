import Zdog from '@mascotte/zdog-reference';
import { describe, it } from 'vitest';
import { euler, quat, vec3 } from '../src/index.ts';
import { expectClose, random, range } from './helpers.ts';

/*
 * Zdog поворачивает вектор сначала вокруг Z, потом вокруг Y, потом вокруг X,
 * но знак поворота вокруг Y у него обратный. Поэтому `rotate` из Zdog совпадает
 * с порядком 'XYZ' и углом `-y`. Это нужно при переносе сцен и сравнении со снимками.
 */
describe('совместимость поворотов с Zdog', () => {
  it("Zdog rotate {x, y, z} = fromEuler {x, -y, z, 'XYZ'}", () => {
    const next = random(7);
    for (let i = 0; i < 200; i++) {
      const rotation = {
        x: range(next, -Math.PI, Math.PI),
        y: range(next, -Math.PI, Math.PI),
        z: range(next, -Math.PI, Math.PI),
      };
      const point = { x: range(next, -20, 20), y: range(next, -20, 20), z: range(next, -20, 20) };

      const zdog = new Zdog.Vector(point);
      zdog.rotate(rotation);

      const q = quat.fromEuler(quat.create(), euler.create(rotation.x, -rotation.y, rotation.z));
      const ours = quat.transformVec3(vec3.create(), q, point);
      expectClose(ours, { x: zdog.x, y: zdog.y, z: zdog.z });
    }
  });
});
