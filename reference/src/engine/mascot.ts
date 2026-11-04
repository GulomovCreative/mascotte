import { Ellipse, Node, PathShape } from '@mascotte/engine';
import { TAU } from '@mascotte/math';
import type { EngineVersion } from '../scene.ts';
import { zdogRotation } from './util.ts';

export const mascotEngine: EngineVersion = {
  build() {
    const root = new Node({ rotation: zdogRotation(-0.2, -0.6) });
    const head = new PathShape({ style: { stroke: 80, color: '#f6a623' } });
    root.add(head);
    for (const side of [-1, 1]) {
      head.add(
        new PathShape({
          path: [
            { type: 'move', point: { x: 0, y: 0 } },
            { type: 'line', point: { x: side * 10, y: -24 } },
          ],
          position: { x: side * 22, y: -26, z: 0 },
          style: { stroke: 16, color: '#e0861a' },
        }),
      );
      // Глаз — декаль на голове: рисуется только по видимой части головы. С выключенным
      // перекрытием в Canvas 2D кадр совпадает с Zdog.Group.
      const eye = new Node({ sortMode: 'attached', position: { x: side * 14, y: -6, z: 36 } });
      eye
        .add(new Ellipse({ diameter: 8, style: { stroke: 6, fill: true, color: '#fff' } }))
        .add(
          new PathShape({ position: { x: 0, y: 0, z: 2 }, style: { stroke: 6, color: '#222' } }),
        );
      head.add(eye);
    }
    head.add(
      new Ellipse({
        diameter: 16,
        quarters: 2,
        rotation: zdogRotation(0, 0, TAU / 4),
        position: { x: 0, y: 12, z: 38 },
        // Рот тоже декаль: он лежит внутри сферы головы и иначе был бы ей закрыт.
        sortMode: 'attached',
        closed: false,
        style: { stroke: 4, color: '#8a3b12' },
      }),
    );
    root.add(
      new PathShape({ position: { x: 0, y: 60, z: 0 }, style: { stroke: 40, color: '#e0861a' } }),
    );
    return root;
  },
  pose(root, time) {
    root.setRotationFromEuler(
      zdogRotation(-0.2 + Math.sin(time * 0.8) * 0.15, -0.6 + Math.sin(time * 1.2) * 0.9),
    );
  },
};
