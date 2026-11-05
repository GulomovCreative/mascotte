import { flatPrimitivesEngine } from '../engine/flat-primitives.ts';
import type { ReferenceScene } from '../scene.ts';

/** Flat primitives: rectangles, ellipses, a polygon, a path with an arc and a Bezier curve, a point, a line. */
export const flatPrimitives: ReferenceScene = {
  id: 'flat-primitives',
  title: 'Flat primitives',
  width: 320,
  height: 240,
  background: '#fdf6e3',
  zoom: 1,
  engine: flatPrimitivesEngine,
};
