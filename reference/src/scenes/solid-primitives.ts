import { solidPrimitivesEngine } from '../engine/solid-primitives.ts';
import type { ReferenceScene } from '../scene.ts';

/** Объёмные примитивы: полусфера, цилиндр, конус, коробка и сфера из точки. */
export const solidPrimitives: ReferenceScene = {
  id: 'solid-primitives',
  title: 'Объёмные примитивы',
  width: 320,
  height: 240,
  background: '#1f2430',
  zoom: 1,
  engine: solidPrimitivesEngine,
};
