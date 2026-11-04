import { euler, vec3 } from '@mascotte/math';
import Zdog from '@mascotte/zdog-reference';
import { describe, expect, it } from 'vitest';
import { Node } from '../src/index.ts';

/*
 * Иерархия трансформаций должна совпадать с Zdog: точка узла проходит через
 * масштаб, поворот и перенос самого узла, потом через те же шаги каждого предка.
 * Поворот Zdog {x, y, z} соответствует углам {x, -y, z} в порядке 'XYZ'.
 */
describe('совместимость иерархии с Zdog', () => {
  it('мировые позиции вложенных узлов совпадают', () => {
    const levels = [
      { translate: { x: 10, y: -4, z: 3 }, rotate: { x: 0.3, y: -0.8, z: 0.2 }, scale: 1.5 },
      { translate: { x: -2, y: 6, z: 1 }, rotate: { x: -0.5, y: 0.4, z: 1.1 }, scale: 0.7 },
      { translate: { x: 3, y: 3, z: -8 }, rotate: { x: 1.2, y: 0.1, z: -0.6 }, scale: 2 },
    ];

    const zdogRoot = new Zdog.Anchor(levels[0]);
    const zdogMiddle = new Zdog.Anchor({ addTo: zdogRoot, ...levels[1] });
    const zdogLeaf = new Zdog.Anchor({ addTo: zdogMiddle, ...levels[2] });
    zdogRoot.updateGraph();

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

    const pairs = [
      [root, zdogRoot],
      [middle, zdogMiddle],
      [leaf, zdogLeaf],
    ] as const;
    for (const [node, anchor] of pairs) {
      const position = node.getWorldPosition(vec3.create());
      expect(position.x).toBeCloseTo(anchor.renderOrigin.x, 9);
      expect(position.y).toBeCloseTo(anchor.renderOrigin.y, 9);
      expect(position.z).toBeCloseTo(anchor.renderOrigin.z, 9);
    }
  });
});
