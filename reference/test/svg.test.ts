import { type Camera, CanvasRenderer, Scene, SvgRenderer, type Viewport } from '@mascotte/engine';
import { buildDocument, readDocument } from '@mascotte/format';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { describe, expect, it } from 'vitest';
import { engineScenes, gloopDocument, misoDocument, pipDocument } from '../src/index.ts';

/** Pixels that differ between the Canvas 2D frame and the SVG export drawn on a canvas. */
async function differing(scene: Scene, camera: Camera, viewport: Viewport): Promise<number> {
  const ratio = viewport.pixelRatio ?? 1;
  const width = viewport.width * ratio;
  const height = viewport.height * ratio;
  const direct = createCanvas(width, height);
  new CanvasRenderer().render(direct.getContext('2d'), scene, camera, viewport);
  const svg = new SvgRenderer().render(scene, camera, viewport);
  const image = await loadImage(Buffer.from(svg));
  const drawn = createCanvas(width, height);
  drawn.getContext('2d').drawImage(image, 0, 0);
  return pixelmatch(
    direct.getContext('2d').getImageData(0, 0, width, height).data,
    drawn.getContext('2d').getImageData(0, 0, width, height).data,
    undefined,
    width,
    height,
    { threshold: 0.1 },
  );
}

describe('SVG export', () => {
  it.each(engineScenes.map((scene) => [scene.id, scene] as const))(
    '%s draws as the Canvas 2D frame',
    async (_, scene) => {
      const { root, camera } = scene.build();
      scene.pose(root, camera, 0.7);
      const viewport = {
        width: scene.width,
        height: scene.height,
        pixelRatio: 2,
        background: scene.background,
      };
      expect(await differing(new Scene(root), camera, viewport)).toBe(0);
    },
  );

  it.each([
    ['pip', pipDocument()],
    ['gloop', gloopDocument],
    ['miso', misoDocument],
  ] as const)(
    '%s, with its tones, outlines and shadow, draws as the Canvas 2D frame',
    async (_, value) => {
      const document = readDocument(value);
      const built = buildDocument(document);
      const { width, height, background } = document.view;
      const viewport = { width, height, pixelRatio: 2, ...(background ? { background } : {}) };
      expect(await differing(new Scene(built.root), built.camera, viewport)).toBe(0);
    },
  );
});
