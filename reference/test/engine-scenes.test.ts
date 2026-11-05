import { describe, expect, it } from 'vitest';
import { engineScenes } from '../src/index.ts';
import { isUpdatingSnapshots, matchSnapshot, renderEngineSceneToPng } from '../src/snapshot.ts';

const expectedStatus = isUpdatingSnapshots() ? 'written' : 'match';

/* Snapshots of features Zdog lacks: compared with the new engine's own references. */
describe('new-engine-only scenes', () => {
  for (const scene of engineScenes) {
    it(`${scene.id} matches the snapshot`, () => {
      const result = matchSnapshot(scene.id, renderEngineSceneToPng(scene, { pixelRatio: 2 }));
      expect(result.status, JSON.stringify(result)).toBe(expectedStatus);
    });

    for (const [i, time] of (scene.snapshotTimes ?? []).entries()) {
      it(`${scene.id} at time ${time.toFixed(2)} matches the snapshot`, () => {
        const png = renderEngineSceneToPng(scene, { pixelRatio: 2, time });
        const result = matchSnapshot(`${scene.id}-${i + 1}`, png);
        expect(result.status, JSON.stringify(result)).toBe(expectedStatus);
      });
    }

    it(`${scene.id}: pose changes the frame`, () => {
      const a = renderEngineSceneToPng(scene);
      const b = renderEngineSceneToPng(scene, { time: 1.5 });
      expect(a.equals(b)).toBe(false);
    });
  }
});
