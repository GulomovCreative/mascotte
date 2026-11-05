import { solidPrimitivesEngine } from '../engine/solid-primitives.ts';
import type { ReferenceScene } from '../scene.ts';

/** Solid primitives: hemisphere, cylinder, cone, box and a sphere made from a point. */
export const solidPrimitives: ReferenceScene = {
  id: 'solid-primitives',
  title: 'Solid primitives',
  width: 320,
  height: 240,
  background: '#1f2430',
  zoom: 1,
  engine: solidPrimitivesEngine,
};
