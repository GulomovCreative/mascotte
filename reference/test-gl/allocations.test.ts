import { Scene, WebGLRenderer } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';
import { buildBenchmark } from '../src/index.ts';

/*
 * Выделения памяти в цикле кадра WebGL2 в настоящем браузере: профилировщик кучи Chrome
 * через CDP, с учётом уже собранных объектов. Обмен с профилировщиком сам выделяет
 * память, поэтому из замера вычитается такой же замер пустой функции.
 */

interface SamplingNode {
  selfSize: number;
  children: SamplingNode[];
}

async function sampledBytes(fn: () => void, runs: number): Promise<number> {
  const session = cdp();
  await session.send('HeapProfiler.enable');
  await session.send('HeapProfiler.startSampling', {
    samplingInterval: 16,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < runs; i++) fn();
  const { profile } = (await session.send('HeapProfiler.stopSampling')) as {
    profile: { head: SamplingNode };
  };
  let total = 0;
  const walk = (node: SamplingNode) => {
    total += node.selfSize;
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  return total;
}

/** Сколько байт в среднем выделяет вызов `fn` сверх пустого вызова. */
async function bytesPerCall(fn: () => void, warmup: number, runs: number): Promise<number> {
  for (let i = 0; i < warmup; i++) fn();
  const empty = await sampledBytes(() => {}, runs);
  const used = await sampledBytes(fn, runs);
  return Math.max(0, used - empty) / runs;
}

const bench = buildBenchmark();
const scene = new Scene(bench.root);

function renderer(): { renderer: WebGLRenderer; draw: () => boolean } {
  const canvas = document.createElement('canvas');
  canvas.width = bench.width;
  canvas.height = bench.height;
  const instance = new WebGLRenderer(canvas, { supersample: 1 });
  const viewport = { width: bench.width, height: bench.height, background: bench.background };
  return { renderer: instance, draw: () => instance.render(scene, bench.camera, viewport) };
}

describe('выделения памяти WebGL2', () => {
  it('в покое кадр не пересобирается и не выделяет памяти', async () => {
    const { renderer: instance, draw } = renderer();
    expect(draw()).toBe(true);
    expect(draw()).toBe(false);
    const bytes = await bytesPerCall(draw, 200, 500);
    expect(bytes, `${bytes} байт на вызов`).toBeLessThan(8);
    // После изменения сцены кадр рисуется снова, после invalidate — тоже.
    bench.pose(1);
    expect(draw()).toBe(true);
    expect(draw()).toBe(false);
    instance.invalidate();
    expect(draw()).toBe(true);
    instance.destroy();
  }, 60_000);

  it('анимированный кадр бенчмарка — не больше 8 КБ', async () => {
    const { renderer: instance, draw } = renderer();
    let time = 0;
    const frame = () => {
      time += 1 / 60;
      bench.pose(time);
      draw();
    };
    // Сейчас 3–7 КБ на кадр из 6000 фигур: пересчёт мировых матриц и вызовы WebGL самого
    // браузера. Порог ловит рост: подмассив на каждый вызов отрисовки давал ~10 КБ, а до
    // переделки одна сборка кадра — ~50 КБ.
    const bytes = await bytesPerCall(frame, 60, 30);
    expect(bytes, `${Math.round(bytes)} байт на кадр`).toBeLessThan(8192);
    instance.destroy();
  }, 120_000);
});
