import {
  Camera,
  CanvasRenderer,
  Capsule,
  Node,
  Scene,
  Sphere,
  SvgRenderer,
  type Viewport,
} from '@mascotte/engine';
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

/**
 * The differing pixels allowed: none, or a few edge pixels where the frame clips (a decal, a
 * sphere cut by another), since Canvas's clip and an SVG clip path antialias a little apart.
 */
function slack(scene: Scene, camera: Camera, viewport: Viewport): number {
  return new SvgRenderer().render(scene, camera, viewport).includes('clip-path') ? 4 : 0;
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
      const world = new Scene(root);
      expect(await differing(world, camera, viewport)).toBeLessThanOrEqual(
        slack(world, camera, viewport),
      );
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
      const scene = new Scene(built.root);
      expect(await differing(scene, built.camera, viewport)).toBeLessThanOrEqual(
        slack(scene, built.camera, viewport),
      );
    },
  );

  it.each([
    ['in front', { x: 0, y: 0, z: 1 }],
    ['from the side', { x: -1, y: 0, z: 0.05 }],
    ['behind and aside', { x: 0.3, y: 0.4, z: -0.8 }],
    ['straight behind', { x: 0, y: 0, z: -1 }],
  ] as const)('the tones lit %s draw as the Canvas 2D frame', async (_, light) => {
    const scene = engineScenes.find((item) => item.id === 'engine-toon');
    if (!scene) throw new Error('no toon scene');
    const { root, camera } = scene.build();
    scene.pose(root, camera, 0.7);
    camera.light = light;
    const viewport = { width: scene.width, height: scene.height, pixelRatio: 2 };
    // A handful of edge pixels may differ: the SVG's arcs and Canvas's ellipses round their
    // antialiased edges a little differently (out of 307 200 pixels).
    expect(
      await differing(new Scene(root), camera, viewport),
      JSON.stringify(light),
    ).toBeLessThanOrEqual(4);
  });

  it('nests the clip of a shaded capsule in the clip of its decal', async () => {
    const head = new Sphere({ diameter: 60, style: { color: '#808080', stroke: 0 } });
    head.add(
      new Capsule({
        length: 20,
        diameter: 8,
        position: { x: 10, y: 0, z: 30 },
        rotation: { x: 0, y: 1.2, z: 0, order: 'XYZ' } as never,
        sortMode: 'attached',
        style: { color: '#7fc8f8', shadowColor: '#4c8fc0', highlightColor: '#ffffff', stroke: 0 },
      }),
    );
    const root = new Node();
    root.add(head);
    const scene = new Scene(root);
    const camera = new Camera();
    const viewport = { width: 100, height: 100, pixelRatio: 2 };
    const svg = new SvgRenderer().render(scene, camera, viewport);
    // The decal's clip, then the capsule's inside it, closed in turn.
    expect(svg.match(/<g clip-path/g)).toHaveLength(2);
    expect(svg.split('<g').length).toBe(svg.split('</g>').length);
    expect(await differing(scene, camera, viewport)).toBe(0);
  });
});
