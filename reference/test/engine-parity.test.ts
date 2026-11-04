import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { referenceScenes } from '../src/index.ts';
import {
  compareImages,
  renderEngineToPng,
  renderSceneToPng,
  snapshotDir,
} from '../src/snapshot.ts';

/*
 * Новое ядро рисует эталонные сцены так же, как копия Zdog: те же команды Canvas 2D
 * в том же порядке. Поэтому кадры совпадают с допуском на сглаживание.
 */
describe('новое ядро против Zdog', () => {
  for (const scene of referenceScenes) {
    it(`${scene.id}: кадр совпадает со снимком Zdog`, () => {
      const png = renderEngineToPng(scene, { pixelRatio: 2 });
      const result = compareImages(readFileSync(join(snapshotDir, `${scene.id}.png`)), png);
      expect(result.status, JSON.stringify({ ...result, diff: undefined })).toBe('match');
    });

    it(`${scene.id}: кадры совпадают с Zdog в нескольких моментах анимации`, () => {
      for (const time of [0.4, 1.3, 2.9]) {
        const zdog = renderSceneToPng(scene, { pixelRatio: 1, time });
        const ours = renderEngineToPng(scene, { pixelRatio: 1, time });
        const result = compareImages(zdog, ours);
        expect(result.status, `${time}: ${JSON.stringify({ ...result, diff: undefined })}`).toBe(
          'match',
        );
      }
    });
  }
});
