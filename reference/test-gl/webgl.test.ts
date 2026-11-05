import {
  Camera,
  Ellipse,
  Node,
  PathShape,
  Scene,
  Sphere,
  type Viewport,
  WebGLRenderer,
} from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { engineScenes, referenceScenes } from '../src/index.ts';

/* Кадры WebGLRenderer в браузере: снимки сцен и точечные проверки пикселей. */

const expectedStatuses = ['match', 'written'];

/** Рисует сцену на новом холсте и возвращает холст; рендерер освобождается. */
function draw(scene: Scene, camera: Camera, viewport: Viewport): HTMLCanvasElement {
  const ratio = viewport.pixelRatio ?? 1;
  const canvas = document.createElement('canvas');
  canvas.width = viewport.width * ratio;
  canvas.height = viewport.height * ratio;
  const renderer = new WebGLRenderer(canvas);
  try {
    renderer.render(scene, camera, viewport);
    // Копия в 2D сразу после кадра: буфер WebGL после показа не сохраняется.
    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    copy.getContext('2d')?.drawImage(canvas, 0, 0);
    return copy;
  } finally {
    renderer.destroy();
  }
}

async function expectSnapshot(name: string, canvas: HTMLCanvasElement): Promise<void> {
  const result = await commands.matchGLSnapshot(name, canvas.toDataURL('image/png'));
  expect(expectedStatuses, JSON.stringify(result)).toContain(result.status);
}

/** RGBA пикселя (x, y) холста. */
function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Нет 2D-контекста.');
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
}

function sceneWith(...nodes: Node[]): Scene {
  const scene = new Scene();
  for (const node of nodes) scene.root.add(node);
  return scene;
}

const camera = new Camera();
const small = { width: 100, height: 100 } as const;

describe('снимки WebGL', () => {
  for (const scene of referenceScenes) {
    it(`эталонная сцена ${scene.id}`, async () => {
      const root = scene.engine.build();
      scene.engine.pose(root, 0);
      const canvas = draw(new Scene(root), new Camera({ zoom: scene.zoom }), {
        width: scene.width,
        height: scene.height,
        pixelRatio: 2,
        background: scene.background,
      });
      await expectSnapshot(scene.id, canvas);
    });
  }

  for (const scene of engineScenes) {
    for (const [i, time] of [0, ...(scene.snapshotTimes ?? [])].entries()) {
      const name = i === 0 ? scene.id : `${scene.id}-${i}`;
      it(`сцена ${name}`, async () => {
        const { root, camera } = scene.build();
        scene.pose(root, camera, time);
        const canvas = draw(new Scene(root), camera, {
          width: scene.width,
          height: scene.height,
          pixelRatio: 2,
          background: scene.background,
        });
        await expectSnapshot(name, canvas);
      });
    }
  }
});

describe('пиксели WebGL', () => {
  it('без фона альфа равна покрытию: непрозрачное 255, полупрозрачное ~128, пусто 0', () => {
    const canvas = draw(
      sceneWith(
        new Sphere({ diameter: 30, position: { x: -20, y: 0, z: 0 }, style: { color: '#f00' } }),
        new Sphere({
          diameter: 30,
          opacity: 0.5,
          position: { x: 20, y: 0, z: 0 },
          style: { color: '#00f' },
        }),
      ),
      camera,
      small,
    );
    expect(pixel(canvas, 30, 50)).toEqual([255, 0, 0, 255]);
    const half = pixel(canvas, 70, 50);
    expect(half.slice(0, 3)).toEqual([0, 0, 255]);
    expect(Math.abs((half[3] ?? 0) - 128)).toBeLessThanOrEqual(1);
    expect(pixel(canvas, 5, 5)).toEqual([0, 0, 0, 0]);
    // Край шара — частичное покрытие.
    const edge = pixel(canvas, 14, 50)[3] ?? 0;
    expect(edge).toBeGreaterThan(0);
    expect(edge).toBeLessThan(255);
  });

  it('полупрозрачная обводка одного тона по всей длине: стыки капсул не темнее', () => {
    const canvas = draw(
      sceneWith(new Ellipse({ diameter: 120, opacity: 0.5, style: { stroke: 12, color: '#000' } })),
      camera,
      { width: 200, height: 200, background: '#fff' },
    );
    const tones = new Set<number>();
    for (let degrees = 0; degrees < 360; degrees += 3) {
      const a = (degrees * Math.PI) / 180;
      tones.add(
        pixel(canvas, Math.round(100 + 60 * Math.cos(a)), Math.round(100 + 60 * Math.sin(a)))[0] ??
          0,
      );
    }
    expect([...tones]).toEqual([128]);
  });

  it('пересечение по пикселям: каждая из двух сфер ближе на своей половине', () => {
    const canvas = draw(
      sceneWith(
        new Sphere({ diameter: 40, position: { x: -6, y: 0, z: 0 }, style: { color: '#f00' } }),
        new Sphere({ diameter: 40, position: { x: 6, y: 0, z: 0 }, style: { color: '#00f' } }),
      ),
      camera,
      { ...small, background: '#fff' },
    );
    expect(pixel(canvas, 46, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(canvas, 54, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('слой −1 под содержимым, даже если ближе; слой +1 над ним, даже если дальше', () => {
    const canvas = draw(
      sceneWith(
        new Sphere({ diameter: 40, style: { color: '#f00' } }),
        new PathShape({
          sortMode: 'layer',
          layer: -1,
          position: { x: -10, y: 0, z: 50 },
          style: { stroke: 8, color: '#0f0' },
        }),
        new PathShape({
          sortMode: 'layer',
          layer: 1,
          position: { x: 10, y: 0, z: -50 },
          style: { stroke: 8, color: '#00f' },
        }),
      ),
      camera,
      { ...small, background: '#fff' },
    );
    expect(pixel(canvas, 40, 50).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(canvas, 60, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });

  it('декаль рисуется только на опоре и не режется ею', () => {
    const head = new Sphere({ diameter: 40, style: { color: '#f00', stroke: 0 } });
    // Точка на краю головы и чуть внутри неё: снаружи силуэта не видна.
    head.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: 20, y: 0, z: -2 },
        style: { stroke: 10, color: '#00f' },
      }),
    );
    const canvas = draw(sceneWith(head), camera, { ...small, background: '#fff' });
    expect(pixel(canvas, 67, 50).slice(0, 3)).toEqual([0, 0, 255]);
    expect(pixel(canvas, 73, 50).slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('полупрозрачное перед декалью смешивается с ней, а не с опорой', () => {
    const head = new Sphere({ diameter: 60, style: { color: '#f00', stroke: 0 } });
    head.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: 0, y: 0, z: 28 },
        style: { stroke: 16, color: '#00f' },
      }),
    );
    const veil = new PathShape({
      opacity: 0.5,
      position: { x: 0, y: 0, z: 60 },
      style: { stroke: 40, color: '#fff' },
    });
    const canvas = draw(sceneWith(head, veil), camera, { ...small, background: '#000' });
    const [r = 0, g = 0, b = 0] = pixel(canvas, 50, 50);
    expect(Math.abs(r - 128)).toBeLessThanOrEqual(1);
    expect(Math.abs(g - 128)).toBeLessThanOrEqual(1);
    expect(b).toBe(255);
  });
});

describe('жизненный цикл WebGLRenderer', () => {
  it('пропускает кадры при потере контекста и восстанавливается', async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 50;
    canvas.height = 50;
    const renderer = new WebGLRenderer(canvas);
    const scene = sceneWith(new Sphere({ diameter: 20 }));
    const viewport = { width: 50, height: 50, background: '#fff' };
    renderer.render(scene, camera, viewport);
    const lose = renderer.gl.getExtension('WEBGL_lose_context');
    expect(lose).not.toBeNull();
    const event = (name: string) =>
      new Promise((resolve) => canvas.addEventListener(name, resolve, { once: true }));
    const lost = event('webglcontextlost');
    lose?.loseContext();
    expect(renderer.contextLost).toBe(true);
    expect(() => renderer.render(scene, camera, viewport)).not.toThrow();
    // Восстановить можно только после события потери, оно приходит асинхронно, и не в той
    // же задаче: вызов прямо из обработчика Chrome пропускает.
    await lost;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restored = event('webglcontextrestored');
    lose?.restoreContext();
    await restored;
    expect(renderer.contextLost).toBe(false);
    renderer.render(scene, camera, viewport);
    expect(renderer.gl.getError()).toBe(renderer.gl.NO_ERROR);
    renderer.destroy();
    expect(() => renderer.render(scene, camera, viewport)).toThrow('уничтожен');
  });

  it('множитель суперсэмплинга по умолчанию 2, на маленьком холсте не снижается', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const renderer = new WebGLRenderer(canvas);
    renderer.render(new Scene(), camera, { width: 64, height: 64 });
    expect(renderer.supersample).toBe(2);
    renderer.destroy();
  });

  it('у узла без рисования в режиме attached декали тоже на опоре', () => {
    const head = new Sphere({ diameter: 40, style: { color: '#f00', stroke: 0 } });
    const eye = new Node({ sortMode: 'attached', position: { x: 0, y: 0, z: 19 } });
    eye.add(new PathShape({ style: { stroke: 10, color: '#00f' } }));
    head.add(eye);
    const canvas = draw(sceneWith(head), camera, { ...small, background: '#fff' });
    expect(pixel(canvas, 50, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });
});
