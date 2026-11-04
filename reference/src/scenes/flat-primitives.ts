import Zdog from '@mascotte/zdog-reference';
import { flatPrimitivesEngine } from '../engine/flat-primitives.ts';
import type { ReferenceScene } from '../scene.ts';

/** Плоские примитивы: прямоугольники, эллипсы, многоугольник, путь с дугой и безье, точка, линия. */
export const flatPrimitives: ReferenceScene = {
  id: 'flat-primitives',
  title: 'Плоские примитивы',
  width: 320,
  height: 240,
  background: '#fdf6e3',
  zoom: 1,
  build() {
    const root = new Zdog.Anchor({ rotate: { x: -0.35, y: 0.5 } });
    new Zdog.Rect({
      addTo: root,
      width: 60,
      height: 40,
      translate: { x: -100, y: -60 },
      stroke: 6,
      color: '#e62',
    });
    new Zdog.RoundedRect({
      addTo: root,
      width: 60,
      height: 40,
      cornerRadius: 12,
      translate: { y: -60 },
      stroke: 4,
      fill: true,
      color: '#c25',
    });
    new Zdog.Ellipse({
      addTo: root,
      diameter: 50,
      translate: { x: 100, y: -60 },
      stroke: 8,
      color: '#636',
    });
    new Zdog.Ellipse({
      addTo: root,
      width: 60,
      height: 36,
      quarters: 2,
      translate: { x: -100, y: 40 },
      stroke: 6,
      color: '#ea0',
    });
    new Zdog.Polygon({
      addTo: root,
      radius: 30,
      sides: 5,
      translate: { y: 40 },
      stroke: 4,
      fill: true,
      color: '#3a8',
    });
    new Zdog.Shape({
      addTo: root,
      path: [
        { x: -20, y: -20 },
        {
          arc: [
            { x: 20, y: -20 },
            { x: 20, y: 20 },
          ],
        },
        {
          bezier: [
            { x: 0, y: 0 },
            { x: 0, y: 40 },
            { x: -20, y: 20 },
          ],
        },
      ],
      closed: false,
      translate: { x: 100, y: 40 },
      stroke: 5,
      color: '#27a',
    });
    new Zdog.Shape({ addTo: root, translate: { x: -40, y: 100 }, stroke: 20, color: '#333' });
    new Zdog.Shape({
      addTo: root,
      path: [{ x: -30 }, { x: 30 }],
      translate: { x: 40, y: 100 },
      stroke: 6,
      color: '#333',
    });
    return root;
  },
  pose(root, time) {
    root.rotate.y = 0.5 + time * 0.6;
  },
  engine: flatPrimitivesEngine,
};
