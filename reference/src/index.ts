import { backfaceGroups } from './scenes/backface-groups.ts';
import { flatPrimitives } from './scenes/flat-primitives.ts';
import { mascot } from './scenes/mascot.ts';
import { solidPrimitives } from './scenes/solid-primitives.ts';

export { type EngineScene, engineScenes } from './engine-only/scenes.ts';
export type { Context2D, EngineVersion, ReferenceScene, RenderOptions } from './scene.ts';
export { renderScene } from './scene.ts';

/** Все эталонные сцены. Для каждой хранится снимок кадра в `reference/snapshots/`. */
export const referenceScenes = [flatPrimitives, solidPrimitives, mascot, backfaceGroups];
