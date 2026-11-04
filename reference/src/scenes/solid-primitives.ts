import Zdog from '@mascotte/zdog-reference';
import type { ReferenceScene } from '../scene.ts';

/** Объёмные примитивы: полусфера, цилиндр, конус, коробка и сфера из точки. */
export const solidPrimitives: ReferenceScene = {
  id: 'solid-primitives',
  title: 'Объёмные примитивы',
  width: 320,
  height: 240,
  background: '#1f2430',
  zoom: 1,
  build() {
    const root = new Zdog.Anchor({ rotate: { x: -0.5, y: 0.6 } });
    new Zdog.Hemisphere({
      addTo: root,
      diameter: 60,
      translate: { x: -90, y: -50 },
      stroke: false,
      color: '#c25',
      backface: '#ea0',
    });
    new Zdog.Cylinder({
      addTo: root,
      diameter: 50,
      length: 50,
      translate: { y: -50 },
      stroke: false,
      color: '#3a8',
      backface: '#e62',
    });
    new Zdog.Cone({
      addTo: root,
      diameter: 50,
      length: 60,
      translate: { x: 90, y: -50 },
      stroke: false,
      color: '#636',
      backface: '#c25',
    });
    new Zdog.Box({
      addTo: root,
      width: 60,
      height: 50,
      depth: 40,
      translate: { x: -50, y: 55 },
      stroke: false,
      color: '#e62',
      leftFace: '#ea0',
      rightFace: '#c25',
      topFace: '#ed0',
      bottomFace: '#636',
    });
    new Zdog.Shape({ addTo: root, translate: { x: 60, y: 55 }, stroke: 60, color: '#27a' });
    return root;
  },
  pose(root, time) {
    root.rotate.y = 0.6 + time * 0.6;
  },
};
