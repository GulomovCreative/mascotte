import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { referenceScenes } from '../src/index.ts';
import { compareImages, renderEngineToPng, zdogSnapshotDir } from '../src/snapshot.ts';

/*
 * Новое ядро рисует эталонные сцены так же, как Zdog: кадры сравниваются со снимками,
 * которые нарисовала копия Zdog, пока она была в репозитории. Снимки не пересоздаются:
 * это замороженный эталон. На практике кадры совпадают пиксель в пиксель; допуск
 * сравнения оставлен на случай разного сглаживания.
 */
function zdogSnapshot(name: string): Buffer {
  return readFileSync(join(zdogSnapshotDir, `${name}.png`));
}

describe('новое ядро против снимков Zdog', () => {
  it('у сцен уникальные id', () => {
    const ids = referenceScenes.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  for (const scene of referenceScenes) {
    it(`${scene.id}: кадр совпадает со снимком Zdog`, () => {
      const png = renderEngineToPng(scene, { pixelRatio: 2 });
      const result = compareImages(zdogSnapshot(scene.id), png);
      expect(result.status, JSON.stringify({ ...result, diff: undefined })).toBe('match');
    });

    it(`${scene.id}: кадры совпадают со снимками Zdog в нескольких моментах анимации`, () => {
      for (const time of [0.4, 1.3, 2.9]) {
        const ours = renderEngineToPng(scene, { pixelRatio: 1, time });
        const result = compareImages(zdogSnapshot(`${scene.id}-${time}`), ours);
        expect(result.status, `${time}: ${JSON.stringify({ ...result, diff: undefined })}`).toBe(
          'match',
        );
      }
    });

    it(`${scene.id}: поза меняет кадр, повторный кадр того же графа тот же`, () => {
      expect(renderEngineToPng(scene).equals(renderEngineToPng(scene, { time: 0.5 }))).toBe(false);
      expect(renderEngineToPng(scene).equals(renderEngineToPng(scene))).toBe(true);
    });
  }
});
