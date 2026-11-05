import { backfaceGroups } from './scenes/backface-groups.ts';
import { flatPrimitives } from './scenes/flat-primitives.ts';
import { mascot } from './scenes/mascot.ts';
import { solidPrimitives } from './scenes/solid-primitives.ts';

export {
  type Benchmark,
  type BenchmarkOptions,
  buildBenchmark,
} from './engine-only/benchmark.ts';
export { type EngineScene, engineScenes } from './engine-only/scenes.ts';
export type { EngineVersion, ReferenceScene, RenderOptions } from './scene.ts';

/** Все эталонные сцены. Для каждой хранятся снимки кадров Zdog в `reference/snapshots/zdog/`. */
export const referenceScenes = [flatPrimitives, solidPrimitives, mascot, backfaceGroups];
