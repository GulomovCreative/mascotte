import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scene } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { referenceScenes } from '../src/index.ts';
import { compareImages, renderEngineToPng, zdogSnapshotDir } from '../src/snapshot.ts';

/*
 * The new engine draws the reference scenes the same way Zdog does: frames are compared with
 * snapshots drawn by the Zdog copy while it was in the repository. The snapshots are never
 * regenerated: they are a frozen reference. In practice the frames match pixel for pixel; the
 * comparison tolerance is kept in case antialiasing differs.
 *
 * The Zdog frames were rasterized with @napi-rs/canvas 1.1.0, the same one the new engine draws
 * with (the version is pinned in reference/package.json). Updating the rasterizer may shift edge
 * antialiasing, and the Zdog snapshots cannot be regenerated: when updating, check the
 * difference and raise the tolerance if needed instead of overwriting the snapshots.
 */
function zdogSnapshot(name: string): Buffer {
  return readFileSync(join(zdogSnapshotDir, `${name}.png`));
}

describe('new engine against Zdog snapshots', () => {
  it('scenes have unique ids', () => {
    const ids = referenceScenes.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const scene of referenceScenes) {
    it(`${scene.id}: frame matches the Zdog snapshot`, () => {
      const png = renderEngineToPng(scene, { pixelRatio: 2 });
      const result = compareImages(zdogSnapshot(scene.id), png);
      expect(result.status, JSON.stringify({ ...result, diff: undefined })).toBe('match');
    });

    it(`${scene.id}: frames match the Zdog snapshots at several animation times`, () => {
      for (const time of [0.4, 1.3, 2.9]) {
        const ours = renderEngineToPng(scene, { pixelRatio: 1, time });
        const result = compareImages(zdogSnapshot(`${scene.id}-${time}`), ours);
        expect(result.status, `${time}: ${JSON.stringify({ ...result, diff: undefined })}`).toBe(
          'match',
        );
      }
    });

    it(`${scene.id}: pose changes the frame, rendering is deterministic`, () => {
      expect(renderEngineToPng(scene).equals(renderEngineToPng(scene, { time: 0.5 }))).toBe(false);
      expect(renderEngineToPng(scene).equals(renderEngineToPng(scene))).toBe(true);
    });

    it(`${scene.id}: rendering the same graph again does not accumulate state`, () => {
      const world = new Scene(scene.engine.build());
      renderEngineToPng(scene, { time: 0.5 }, world);
      expect(renderEngineToPng(scene, {}, world).equals(renderEngineToPng(scene))).toBe(true);
    });
  }
});
