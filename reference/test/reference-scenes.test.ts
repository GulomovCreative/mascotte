import { describe, expect, it } from 'vitest';
import { referenceScenes } from '../src/index.ts';
import { isUpdatingSnapshots, matchSnapshot, renderSceneToPng } from '../src/snapshot.ts';

const expectedStatus = isUpdatingSnapshots() ? 'written' : 'match';

describe('эталонные сцены Zdog', () => {
  it('у сцен уникальные id', () => {
    const ids = referenceScenes.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const scene of referenceScenes) {
    describe(scene.id, () => {
      it('совпадает со снимком', () => {
        const result = matchSnapshot(scene.id, renderSceneToPng(scene, { pixelRatio: 2 }));
        expect(result.status, JSON.stringify(result)).toBe(expectedStatus);
      });

      it('рендер детерминирован', () => {
        expect(renderSceneToPng(scene).equals(renderSceneToPng(scene))).toBe(true);
      });

      it('pose меняет кадр со временем', () => {
        expect(renderSceneToPng(scene, { time: 0.5 }).equals(renderSceneToPng(scene))).toBe(false);
      });

      it('повторный рендер того же графа не накапливает состояние', () => {
        const root = scene.build();
        renderSceneToPng(scene, { time: 0.5 }, root);
        expect(renderSceneToPng(scene, {}, root).equals(renderSceneToPng(scene))).toBe(true);
      });
    });
  }
});
