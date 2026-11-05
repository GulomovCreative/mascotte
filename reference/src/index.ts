import { backfaceGroups } from './scenes/backface-groups.ts';
import { flatPrimitives } from './scenes/flat-primitives.ts';
import { mascot } from './scenes/mascot.ts';
import { solidPrimitives } from './scenes/solid-primitives.ts';

export {
  type Benchmark,
  type BenchmarkOptions,
  buildBenchmark,
} from './engine-only/benchmark.ts';
export { lookAroundClip } from './engine-only/clips.ts';
export { type EngineScene, engineScenes } from './engine-only/scenes.ts';
export type { EngineVersion, ReferenceScene, RenderOptions } from './scene.ts';

/**
 * All reference scenes. Zdog frame snapshots for each are stored in `reference/snapshots/zdog/`.
 */
export const referenceScenes = [flatPrimitives, solidPrimitives, mascot, backfaceGroups];
