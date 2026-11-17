import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Animator, CanvasRenderer, Scene } from '@mascotte/engine';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { describe, expect, it } from 'vitest';
import { engineScenes, pip } from '../src/index.ts';
import { snapshotDir } from '../src/snapshot.ts';

describe('Canvas 2D and WebGL', () => {
  // Pip's belly is a sphere sunk in its body: Canvas 2D cuts it by the body as WebGL's depth
  // does, so from the front, the side and the back it is the same patch on the body.
  it.each([
    ['calm', null],
    ['side', 0.65],
    ['back', 1.25],
  ] as const)('draw Pip %s alike', async (name, yaw) => {
    const { root, camera, rig } = pip.build();
    const world = new Scene(root);
    const animator = new Animator(world, { rig });
    pip.animate(animator);
    animator.springsEnabled = false;
    if (yaw !== null) world.root.rotation.set(0, Math.sin(yaw), 0, Math.cos(yaw));
    for (let frame = 0; frame < 30; frame++) animator.update(1 / 60);
    const size = pip.width * 2;
    const canvas = createCanvas(size, size);
    new CanvasRenderer().render(canvas.getContext('2d'), world, camera, {
      width: pip.width,
      height: pip.height,
      pixelRatio: 2,
      background: pip.background,
    });
    const snapshot = await loadImage(
      readFileSync(join(snapshotDir, 'gl', `${pip.id}-${name}.png`)),
    );
    const gl = createCanvas(size, size);
    gl.getContext('2d').drawImage(snapshot, 0, 0);
    const differing = pixelmatch(
      canvas.getContext('2d').getImageData(0, 0, size, size).data,
      gl.getContext('2d').getImageData(0, 0, size, size).data,
      undefined,
      size,
      size,
      { threshold: 0.1 },
    );
    // The usual Canvas 2D differences (edges, the crest's strokes): well under half a percent;
    // with the belly drawn whole it was nearly five percent from the front.
    expect(differing / (size * size)).toBeLessThan(0.005);
  });

  // Spheres in spheres, with outlines, from the front and turned aside: the Canvas 2D cut and
  // its outline against WebGL's depth and rings.
  it.each([
    ['', 0],
    ['-1', Math.PI / 2],
  ] as const)('draw the spheres in spheres%s alike', async (suffix, time) => {
    const scene = engineScenes.find((item) => item.id === 'engine-sphere-cuts');
    if (!scene) throw new Error('no sphere cut scene');
    const { root, camera } = scene.build();
    scene.pose(root, camera, time);
    const width = scene.width * 2;
    const height = scene.height * 2;
    const canvas = createCanvas(width, height);
    new CanvasRenderer().render(canvas.getContext('2d'), new Scene(root), camera, {
      width: scene.width,
      height: scene.height,
      pixelRatio: 2,
      background: scene.background,
    });
    const snapshot = await loadImage(
      readFileSync(join(snapshotDir, 'gl', `engine-sphere-cuts${suffix}.png`)),
    );
    const gl = createCanvas(width, height);
    gl.getContext('2d').drawImage(snapshot, 0, 0);
    const differing = pixelmatch(
      canvas.getContext('2d').getImageData(0, 0, width, height).data,
      gl.getContext('2d').getImageData(0, 0, width, height).data,
      undefined,
      width,
      height,
      { threshold: 0.1 },
    );
    expect(differing / (width * height)).toBeLessThan(0.005);
  });
});
