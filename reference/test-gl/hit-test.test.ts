import {
  Camera,
  DepthSorter,
  type Drawable,
  HitTester,
  type Node,
  Scene,
  WebGLRenderer,
} from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { engineScenes, referenceScenes } from '../src/index.ts';

/*
 * Проверка попадания против настоящего кадра WebGL2: каждой фигуре дан свой цвет,
 * и в каждом пикселе внутри фигур цвет кадра должен быть цветом найденной фигуры.
 * Пиксели у краёв (соседи другого цвета) пропускаются: там цвет смешан сглаживанием.
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
  // Сцены с полупрозрачным смешивают цвета, их здесь нет.
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

/** Уникальный цвет фигуры `i`: каналы разнесены, чтобы сглаживание не дало чужой цвет. */
function colorOf(i: number): [number, number, number] {
  return [40 + ((i * 53) % 200), 40 + ((i * 97) % 200), 40 + ((i * 29) % 200)];
}

describe('проверка попадания совпадает с кадром WebGL', () => {
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
      if (!ctx) throw new Error('Нет 2D-контекста.');
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
          // Только пиксели с одноцветным окружением 3×3.
          let uniform = true;
          for (let dy = -1; dy <= 1 && uniform; dy++) {
            for (let dx = -1; dx <= 1 && uniform; dx++) uniform = same(rgb(x + dx, y + dy), center);
          }
          if (!uniform) continue;
          const hit = tester.hitTest(model, camera, viewport, x + 0.5, y + 0.5);
          const expected = hit ? colors.get(hit.drawable) : BACKGROUND;
          if (!expected) throw new Error(`Фигура ${hit?.drawable.id} не из списка сцены.`);
          checked++;
          if (!same(center, expected)) {
            const name = hit ? hit.drawable.id : 'фон';
            mismatches.push(
              `(${x}, ${y}): ждали ${name} [${expected.join(', ')}], в кадре [${center.join(', ')}]`,
            );
          }
        }
      }
      expect(checked).toBeGreaterThan(1000);
      // Совпасть должны все проверенные пиксели: на SwiftShader расхождений нет, а неверное
      // правило декалей даёт их всего несколько, поэтому допуск — два пикселя на стыках.
      expect(mismatches.length, mismatches.slice(0, 5).join('\n')).toBeLessThanOrEqual(2);
    });
  }
});
