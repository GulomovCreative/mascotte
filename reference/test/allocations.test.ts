import { Camera, DepthSorter, GLCollector, HitTester, Scene } from '@mascotte/engine';
import { describe, expect, it } from 'vitest';
import { allocatedBytesPerCall } from '../src/allocations.ts';
import { buildBenchmark, engineScenes, referenceScenes } from '../src/index.ts';

/*
 * Выделения памяти в цикле кадра. Профилировщик кучи V8 считает и уже собранные объекты,
 * так что видно каждое выделение; на коротком прогоне его разброс — до сотни байт.
 *
 * Без изменений сцены WebGL2 вообще не пересобирает кадр (см. тесты в браузере), а здесь
 * проверяется сама сборка. Когда сцена не меняется, она выделяет доли байта на фигуру:
 * остаются только дробные числа, которые V8 упаковывает при невстроенных вызовах (например,
 * масштаб перспективы). При анимации пересчитываются мировые матрицы — около 2 КБ на кадр
 * из 6000 фигур. Сколько чисел упакует V8, зависит от его решений о встраивании и разнится
 * между машинами (в CI проверка попадания выделяла 5 КБ против 2 КБ локально), поэтому
 * пороги с запасом. Они ловят рост: раньше сборка бенчмарка выделяла около 50 КБ на кадр.
 */

const bench = buildBenchmark();
const scene = new Scene(bench.root);

describe('бенчмарк', () => {
  it('20 маскотов по 300 рисуемых узлов', () => {
    expect(bench.drawables).toBe(6000);
  });
});

describe('выделения памяти в цикле кадра', () => {
  it('сортировка неизменной сцены — почти без выделений', async () => {
    const sorter = new DepthSorter();
    const bytes = await allocatedBytesPerCall(() => sorter.sort(scene, bench.camera), {
      warmup: 500,
      runs: 100,
    });
    expect(bytes, `${Math.round(bytes)} байт`).toBeLessThan(256);
  }, 60_000);

  it('сборка кадра WebGL2 неизменной сцены — почти без выделений', async () => {
    const collector = new GLCollector();
    const bytes = await allocatedBytesPerCall(() => collector.collect(scene, bench.camera), {
      warmup: 300,
      runs: 60,
    });
    expect(bytes, `${Math.round(bytes)} байт`).toBeLessThan(256);
  }, 60_000);

  it('сборка эталонных сцен и сцен нового ядра — почти без выделений', async () => {
    const cases = [
      ...referenceScenes.map((s) => {
        const root = s.engine.build();
        s.engine.pose(root, 0);
        return { id: s.id, scene: new Scene(root), camera: new Camera({ zoom: s.zoom }) };
      }),
      ...engineScenes.map((s) => {
        const { root, camera } = s.build();
        s.pose(root, camera, 0.7);
        return { id: s.id, scene: new Scene(root), camera };
      }),
    ];
    for (const { id, scene, camera } of cases) {
      const collector = new GLCollector();
      const bytes = await allocatedBytesPerCall(() => collector.collect(scene, camera), {
        warmup: 3000,
        runs: 300,
      });
      // Мелкие сцены: несколько упакованных чисел на фигуру, сколько именно — зависит от
      // встраивания на машине (в CI «Маскот в 3D» давал 287 байт против ~100 локально).
      expect(bytes, `${id}: ${Math.round(bytes)} байт`).toBeLessThan(1024);
    }
  }, 120_000);

  it('анимация: поза, сортировка и сборка кадра — не больше 8 КБ на кадр', async () => {
    const collector = new GLCollector();
    let time = 0;
    const bytes = await allocatedBytesPerCall(
      () => {
        time += 1 / 60;
        bench.pose(time);
        collector.collect(scene, bench.camera);
      },
      { warmup: 300, runs: 60 },
    );
    expect(bytes, `${Math.round(bytes)} байт`).toBeLessThan(8192);
  }, 60_000);

  it('проверка попадания по 6000 фигурам — не больше 16 КБ', async () => {
    const tester = new HitTester();
    const bytes = await allocatedBytesPerCall(
      () => tester.hitTest(scene, bench.camera, bench, bench.width / 2, bench.height / 2),
      { warmup: 100, runs: 30 },
    );
    expect(bytes, `${Math.round(bytes)} байт`).toBeLessThan(16384);
  }, 60_000);
});
