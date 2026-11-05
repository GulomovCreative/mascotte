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
  engine: flatPrimitivesEngine,
};
