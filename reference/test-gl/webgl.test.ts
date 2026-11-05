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
    const ctx = copy.getContext('2d');
    if (!ctx) throw new Error('Нет 2D-контекста.');
    ctx.drawImage(canvas, 0, 0);
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
    // Один тон на всём кольце; на стыках с двойным смешиванием он упал бы примерно до 64.
    for (const tone of tones) expect(Math.abs(tone - 128)).toBeLessThanOrEqual(1);
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

  it('декаль видна только внутри силуэта опоры и не скрыта ею, хотя чуть глубже', () => {
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
  it('полупрозрачная декаль на непрозрачной опоре смешивается с ней', () => {
    const head = new Sphere({ diameter: 60, style: { color: '#f00', stroke: 0 } });
    head.add(
      new PathShape({
        sortMode: 'attached',
        opacity: 0.3,
        position: { x: 0, y: 0, z: 28 },
        style: { stroke: 16, color: '#00f' },
      }),
    );
    const canvas = draw(sceneWith(head), camera, { ...small, background: '#000' });
    // Смешивание: 0,7 красного и 0,3 синего. Без него alpha-to-coverage закрыла бы лишь
    // часть выборок, кратную четверти, — около (192, 0, 64).
    const [r = 0, g = 0, b = 0, a = 0] = pixel(canvas, 50, 50);
    expect(Math.abs(r - 178.5)).toBeLessThanOrEqual(1);
    expect(g).toBe(0);
    expect(Math.abs(b - 76.5)).toBeLessThanOrEqual(1);
    expect(a).toBe(255);
  });

  it('номера опор не переходят в следующий слой', () => {
    // Обе опоры получают номер 1 в своих слоях. Декаль правой опоры заходит на левую:
    // там её быть не должно, иначе номер левой опоры остался в трафарете.
    const left = new Sphere({
      diameter: 30,
      position: { x: -15, y: 0, z: 0 },
      style: { color: '#f00', stroke: 0 },
    });
    left.add(new PathShape({ sortMode: 'attached', position: { x: 0, y: 12, z: 14 } }));
    const right = new Sphere({
      sortMode: 'layer',
      layer: 1,
      diameter: 30,
      position: { x: 15, y: 0, z: 0 },
      style: { color: '#0f0', stroke: 0 },
    });
    right.add(
      new PathShape({
        sortMode: 'attached',
        position: { x: -30, y: 0, z: 0 },
        style: { stroke: 20, color: '#00f' },
      }),
    );
    const canvas = draw(sceneWith(left, right), camera, { ...small, background: '#fff' });
    expect(pixel(canvas, 35, 50).slice(0, 3)).toEqual([255, 0, 0]);
  });

  it('после 127 полупрозрачных фигур номера в трафарете начинаются заново без пропусков', () => {
    // 128 точек не перекрываются; 129-я — поверх первой и должна смешаться с ней.
    const dots: Node[] = [];
    const dot = (x: number, y: number) =>
      new PathShape({
        opacity: 0.5,
        position: { x, y, z: 0 },
        style: { stroke: 4, color: '#000' },
      });
    for (let j = 0; j < 8; j++) {
      for (let i = 0; i < 16; i++) dots.push(dot(-45 + 6 * i, -21 + 6 * j));
    }
    dots.push(dot(-45, -21));
    const canvas = draw(sceneWith(...dots), camera, { width: 100, height: 60, background: '#fff' });
    // Одна точка — 128, две друг на друге — 64.
    expect(Math.abs((pixel(canvas, 5, 9)[0] ?? 0) - 64)).toBeLessThanOrEqual(1);
    expect(Math.abs((pixel(canvas, 11, 9)[0] ?? 0) - 128)).toBeLessThanOrEqual(1);
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
    // Событие потери приходит асинхронно. Восстанавливать можно только после него и не в той
    // же задаче, что и обработчик: такой вызов restoreContext Chrome пропускает.
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
