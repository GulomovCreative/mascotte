import Zdog from '@mascotte/zdog-reference';
import { mascotEngine } from '../engine/mascot.ts';
import type { ReferenceScene } from '../scene.ts';

/**
 * Простой маскот: голова-сфера с глазами, ушами и ртом. Проверяет порядок отрисовки
 * мелких деталей на поверхности при повороте, где Zdog сортирует грубо.
 */
export const mascot: ReferenceScene = {
  id: 'mascot',
  title: 'Маскот',
  width: 240,
  height: 240,
  background: '#e8f1f2',
  zoom: 1.5,
  build() {
    const root = new Zdog.Anchor({ rotate: { x: -0.2, y: -0.6 } });
    const head = new Zdog.Shape({ addTo: root, stroke: 80, color: '#f6a623' });
    for (const side of [-1, 1]) {
      new Zdog.Shape({
        addTo: head,
        path: [
          { x: 0, y: 0 },
          { x: side * 10, y: -24 },
        ],
        translate: { x: side * 22, y: -26 },
        stroke: 16,
        color: '#e0861a',
      });
      const eye = new Zdog.Group({ addTo: head, translate: { x: side * 14, y: -6, z: 36 } });
      new Zdog.Ellipse({ addTo: eye, diameter: 8, stroke: 6, fill: true, color: '#fff' });
      new Zdog.Shape({ addTo: eye, translate: { z: 2 }, stroke: 6, color: '#222' });
    }
    new Zdog.Ellipse({
      addTo: head,
      diameter: 16,
      quarters: 2,
      rotate: { z: Zdog.TAU / 4 },
      translate: { y: 12, z: 38 },
      closed: false,
      stroke: 4,
      color: '#8a3b12',
    });
    new Zdog.Shape({ addTo: root, translate: { y: 60 }, stroke: 40, color: '#e0861a' });
    return root;
  },
  pose(root, time) {
    root.rotate.y = -0.6 + Math.sin(time * 1.2) * 0.9;
    root.rotate.x = -0.2 + Math.sin(time * 0.8) * 0.15;
  },
  engine: mascotEngine,
};
