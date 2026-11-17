import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Animator, type Camera, CanvasRenderer, Scene } from '@mascotte/engine';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { describe, expect, it } from 'vitest';
import { engineScenes, pip } from '../src/index.ts';
import { snapshotDir } from '../src/snapshot.ts';

/**
 * The share of pixels that differ between `world` drawn in Canvas 2D at twice the size of `frame`
 * and the WebGL snapshot `file`.
 */
async function differingFromGl(
  world: Scene,
  camera: Camera,
  frame: { width: number; height: number; background: string },
  file: string,
): Promise<number> {
  const width = frame.width * 2;
  const height = frame.height * 2;
  const canvas = createCanvas(width, height);
  new CanvasRenderer().render(canvas.getContext('2d'), world, camera, {
    width: frame.width,
    height: frame.height,
    pixelRatio: 2,
    background: frame.background,
  });
  const snapshot = await loadImage(readFileSync(join(snapshotDir, 'gl', file)));
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
  return differing / (width * height);
}

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
    // The usual Canvas 2D differences (edges, the crest's strokes): well under half a percent;
    // with the belly drawn whole it was nearly five percent from the front.
    expect(await differingFromGl(world, camera, pip, `${pip.id}-${name}.png`)).toBeLessThan(0.005);
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
    const differing = await differingFromGl(
      new Scene(root),
      camera,
      scene,
      `engine-sphere-cuts${suffix}.png`,
    );
    expect(differing).toBeLessThan(0.005);
  });
});
