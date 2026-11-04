import { describe, expect, it } from 'vitest';
import { engineScenes } from '../src/index.ts';
import { isUpdatingSnapshots, matchSnapshot, renderEngineSceneToPng } from '../src/snapshot.ts';

const expectedStatus = isUpdatingSnapshots() ? 'written' : 'match';

/* Снимки того, чего нет в Zdog: сравниваются с собственными эталонами нового ядра. */
describe('сцены только для нового ядра', () => {
  for (const scene of engineScenes) {
    it(`${scene.id} совпадает со снимком`, () => {
      const result = matchSnapshot(scene.id, renderEngineSceneToPng(scene, { pixelRatio: 2 }));
      expect(result.status, JSON.stringify(result)).toBe(expectedStatus);
    });

    it(`${scene.id}: pose меняет кадр`, () => {
      const a = renderEngineSceneToPng(scene);
      const b = renderEngineSceneToPng(scene, { time: 1.5 });
      expect(a.equals(b)).toBe(false);
    });
  }
});
