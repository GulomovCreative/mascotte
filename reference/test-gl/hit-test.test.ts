import {
  Camera,
  DepthSorter,
  type Drawable,
  HitTester,
  type Node,
  Rect,
  Scene,
  WebGLRenderer,
} from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { engineScenes, referenceScenes } from '../src/index.ts';

/*
 * Hit testing against a real WebGL2 frame: each shape gets its own color, and in every pixel
 * inside shapes the frame color must be the color of the shape that was hit. Pixels at edges
 * (neighbors of another color) are skipped: antialiasing mixes the color there.
 */

interface Case {
  id: string;
  width: number;
  height: number;
  build(): { root: Node; camera: Camera };
}

const cases: Case[] = [
  ...referenceScenes.map((scene) => ({
    id: scene.id,
    width: scene.width,
    height: scene.height,
    build() {
      const root = scene.engine.build();
      scene.engine.pose(root, 0);
      return { root, camera: new Camera({ zoom: scene.zoom }) };
    },
  })),
  // Scenes with translucent shapes mix colors, so they are left out.
  ...engineScenes
    .filter((scene) => scene.id !== 'engine-layers-opacity')
    .map((scene) => ({
      id: scene.id,
      width: scene.width,
      height: scene.height,
      build() {
        const { root, camera } = scene.build();
        scene.pose(root, camera, 0.7);
        return { root, camera };
      },
    })),
];

const BACKGROUND = [0, 0, 0];

/** A unique color for shape `i`: channels are spread apart so antialiasing cannot produce another shape's color. */
function colorOf(i: number): [number, number, number] {
  return [40 + ((i * 53) % 200), 40 + ((i * 97) % 200), 40 + ((i * 29) % 200)];
}

describe('hit test matches the WebGL frame', () => {
  for (const scene of cases) {
    it(scene.id, () => {
      const { root, camera } = scene.build();
      const model = new Scene(root);
      const drawables = [...new DepthSorter().sort(model, camera)];
      const colors = new Map<Drawable, number[]>();
      for (const [i, drawable] of drawables.entries()) {
        const [r, g, b] = colorOf(i);
        const css = `rgb(${r}, ${g}, ${b})`;
        drawable.style.color = css;
        drawable.style.backfaceColor = null;
        colors.set(drawable, [r, g, b]);
      }

      const canvas = document.createElement('canvas');
      canvas.width = scene.width;
      canvas.height = scene.height;
      const renderer = new WebGLRenderer(canvas);
      const viewport = { width: scene.width, height: scene.height, background: '#000' };
      renderer.render(model, camera, viewport);
      const copy = document.createElement('canvas');
      copy.width = scene.width;
      copy.height = scene.height;
      const ctx = copy.getContext('2d');
      if (!ctx) throw new Error('No 2D context.');
      ctx.drawImage(canvas, 0, 0);
      renderer.destroy();
      const data = ctx.getImageData(0, 0, scene.width, scene.height).data;
      const rgb = (x: number, y: number) => {
        const i = (y * scene.width + x) * 4;
        return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0];
      };
      const same = (a: number[], b: number[]) =>
        a.length === b.length && a.every((v, k) => Math.abs(v - (b[k] ?? 0)) <= 2);

      const tester = new HitTester();
      let checked = 0;
      const mismatches: string[] = [];
      for (let y = 1; y < scene.height - 1; y += 2) {
        for (let x = 1; x < scene.width - 1; x += 2) {
          const center = rgb(x, y);
          // Only pixels with a uniform 3×3 neighborhood.
          let uniform = true;
          for (let dy = -1; dy <= 1 && uniform; dy++) {
            for (let dx = -1; dx <= 1 && uniform; dx++) uniform = same(rgb(x + dx, y + dy), center);
          }
          if (!uniform) continue;
          const hit = tester.hitTest(model, camera, viewport, x + 0.5, y + 0.5);
          const expected = hit ? colors.get(hit.drawable) : BACKGROUND;
          if (!expected) throw new Error(`Shape ${hit?.drawable.id} is not in the scene list.`);
          checked++;
          if (!same(center, expected)) {
            const name = hit ? hit.drawable.id : 'background';
            mismatches.push(
              `(${x}, ${y}): expected ${name} [${expected.join(', ')}], frame has [${center.join(', ')}]`,
            );
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      // SwiftShader shows no mismatches, and a wrong decal rule produces only a few, so there
      // is no tolerance. Translucent scenes are not checked here: their rules are covered by
      // the Node tests.
      expect(mismatches, mismatches.slice(0, 5).join('\n')).toHaveLength(0);
    });
  }
});

/** A 100×100 WebGL frame of the scene on a black background, as a 2D canvas. */
function frame(scene: Scene): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = 100;
  canvas.height = 100;
  const renderer = new WebGLRenderer(canvas);
  renderer.render(scene, new Camera(), { width: 100, height: 100, background: '#000' });
  const copy = document.createElement('canvas');
  copy.width = 100;
  copy.height = 100;
  const ctx = copy.getContext('2d');
  if (!ctx) throw new Error('No 2D context.');
  ctx.drawImage(canvas, 0, 0);
  renderer.destroy();
  return ctx;
}

describe('hit test at edges and at equal depth', () => {
  it('pixel center: the rectangle edge matches the edge in the frame', () => {
    // Edges at whole pixels 40 and 60: pixel 40 is inside, 39 outside.
    const scene = new Scene();
    scene.root.add(
      new Rect({ width: 20, height: 20, style: { fill: true, stroke: 0, color: '#fff' } }),
    );
    const ctx = frame(scene);
    const tester = new HitTester();
    const camera = new Camera();
    const viewport = { width: 100, height: 100 };
    for (const [x, y] of [
      [39, 50],
      [40, 50],
      [59, 50],
      [60, 50],
      [50, 39],
      [50, 40],
      [50, 59],
      [50, 60],
    ] as const) {
      const lit = (ctx.getImageData(x, y, 1, 1).data[0] ?? 0) > 127;
      const hit = tester.hitTest(scene, camera, viewport, x + 0.5, y + 0.5) !== null;
      expect(hit, `pixel (${x}, ${y})`).toBe(lit);
    }
  });

  it('at equal depth the same shape is hit as is visible in the frame', () => {
    const scene = new Scene();
    const first = new Rect({
      width: 30,
      height: 30,
      style: { fill: true, stroke: 0, color: '#f00' },
    });
    const second = new Rect({
      width: 30,
      height: 30,
      position: { x: 10, y: 0, z: 0 },
      style: { fill: true, stroke: 0, color: '#00f' },
    });
    scene.root.add(first);
    scene.root.add(second);
    const ctx = frame(scene);
    const [r = 0, , b = 0] = ctx.getImageData(55, 50, 1, 1).data;
    const visible = r > b ? first : second;
    expect(
      new HitTester().hitTest(scene, new Camera(), { width: 100, height: 100 }, 55.5, 50.5)
        ?.drawable,
    ).toBe(visible);
  });
});
