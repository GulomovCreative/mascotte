import { backfaceGroups } from './scenes/backface-groups.ts';
import { flatPrimitives } from './scenes/flat-primitives.ts';
import { mascot } from './scenes/mascot.ts';
import { solidPrimitives } from './scenes/solid-primitives.ts';

export type { Context2D, ReferenceScene, RenderOptions } from './scene.ts';
export { renderScene } from './scene.ts';

/** Все эталонные сцены. Для каждой хранится снимок кадра в `reference/snapshots/`. */
export const referenceScenes = [flatPrimitives, solidPrimitives, mascot, backfaceGroups];
