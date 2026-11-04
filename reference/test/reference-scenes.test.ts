import { describe, expect, it } from 'vitest';
import { referenceScenes } from '../src/index.ts';
import { matchSnapshot, renderSceneToPng } from '../src/snapshot.ts';

describe('эталонные сцены Zdog', () => {
  it('у сцен уникальные id', () => {
    const ids = referenceScenes.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const scene of referenceScenes) {
    it(`${scene.id} совпадает со снимком`, () => {
      const png = renderSceneToPng(scene, { pixelRatio: 2 });
      const result = matchSnapshot(scene.id, png);
      expect(result.status, JSON.stringify(result)).toMatch(/^(match|written)$/);
    });
  }

  it('рендер детерминирован', () => {
    for (const scene of referenceScenes) {
      expect(renderSceneToPng(scene).equals(renderSceneToPng(scene))).toBe(true);
    }
  });
});
