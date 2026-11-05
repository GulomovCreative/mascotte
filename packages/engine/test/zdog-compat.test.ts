import { euler, vec3 } from '@mascotte/math';
import { describe, expect, it } from 'vitest';
import { Node } from '../src/index.ts';
import { zdogFixture } from './zdog-fixture.ts';

const zdog = zdogFixture('hierarchy');

/*
 * Иерархия трансформаций должна совпадать с Zdog: точка узла проходит через
 * масштаб, поворот и перенос самого узла, потом через те же шаги каждого предка.
 * Поворот Zdog {x, y, z} соответствует углам {x, -y, z} в порядке 'XYZ'.
 * У Zdog нет pivot, поэтому он здесь не участвует.
 */
describe('совместимость иерархии с Zdog', () => {
  it('мировые позиции вложенных узлов совпадают', () => {
    const levels = [
      { translate: { x: 10, y: -4, z: 3 }, rotate: { x: 0.3, y: -0.8, z: 0.2 }, scale: 1.5 },
      { translate: { x: -2, y: 6, z: 1 }, rotate: { x: -0.5, y: 0.4, z: 1.1 }, scale: 0.7 },
      {
        translate: { x: 3, y: 3, z: -8 },
        rotate: { x: 1.2, y: 0.1, z: -0.6 },
        scale: { x: 2, y: 0.5, z: 1.3 },
      },
    ];
    // Точка внутри листа: на её положение влияют его собственные поворот и масштаб.
    const offset = { x: 1, y: -2, z: 3 };

    // Мировые позиции корня, середины, листа и точки внутри листа у Zdog.
    const origins = zdog.next<{ x: number; y: number; z: number }[]>('origins', { levels, offset });

    const nodes = levels.map(
      ({ translate, rotate, scale }) =>
        new Node({
          position: translate,
          rotation: euler.create(rotate.x, -rotate.y, rotate.z),
          scale,
        }),
    );
    const [root, middle, leaf] = nodes as [Node, Node, Node];
    root.add(middle);
    middle.add(leaf);

    const ours = [
      root.getWorldPosition(vec3.create()),
      middle.getWorldPosition(vec3.create()),
      leaf.getWorldPosition(vec3.create()),
      leaf.localToWorld(vec3.create(), offset),
    ];
    expect(origins).toHaveLength(4);
    ours.forEach((position, i) => {
      const origin = origins[i] ?? { x: Number.NaN, y: Number.NaN, z: Number.NaN };
      expect(position.x).toBeCloseTo(origin.x, 9);
      expect(position.y).toBeCloseTo(origin.y, 9);
      expect(position.z).toBeCloseTo(origin.z, 9);
    });
  });
});
