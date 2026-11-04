// Снимки кадров для тестов в Node. Не импортировать в браузерный код.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Anchor } from '@mascotte/zdog-reference';
import { createCanvas } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { type ReferenceScene, type RenderOptions, renderScene } from './scene.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const snapshotDir = join(root, 'snapshots');
export const diffDir = join(root, 'test', '__diff__');

/**
 * Рисует сцену в canvas Node и возвращает PNG. По умолчанию граф строится заново,
 * но можно передать уже построенный корень, чтобы рисовать один граф несколько раз.
 */
export function renderSceneToPng(
  scene: ReferenceScene,
  options: RenderOptions = {},
  sceneRoot: Anchor = scene.build(),
): Buffer {
  const pixelRatio = options.pixelRatio ?? 1;
  const canvas = createCanvas(scene.width * pixelRatio, scene.height * pixelRatio);
  renderScene(scene, sceneRoot, canvas.getContext('2d'), options);
  return canvas.toBuffer('image/png');
}

export interface CompareOptions {
  /** Чувствительность сравнения цвета пикселя, от 0 до 1 (параметр pixelmatch). */
  threshold?: number;
  /** Допустимая доля отличающихся пикселей. */
  maxDiffRatio?: number;
}

export interface Size {
  width: number;
  height: number;
}

export type CompareResult =
  | { status: 'match'; diffPixels: number; ratio: number }
  | { status: 'mismatch'; diffPixels: number; ratio: number; diff: Buffer }
  | { status: 'size-mismatch'; expected: Size; actual: Size };

/** Сравнивает два PNG, ничего не записывая на диск. */
export function compareImages(
  expectedPng: Buffer,
  actualPng: Buffer,
  { threshold = 0.1, maxDiffRatio = 0.001 }: CompareOptions = {},
): CompareResult {
  const expected = PNG.sync.read(expectedPng);
  const actual = PNG.sync.read(actualPng);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      status: 'size-mismatch',
      expected: { width: expected.width, height: expected.height },
      actual: { width: actual.width, height: actual.height },
    };
  }
  const { width, height } = expected;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, {
    threshold,
  });
  const ratio = diffPixels / (width * height);
  if (ratio <= maxDiffRatio) {
    return { status: 'match', diffPixels, ratio };
  }
  return { status: 'mismatch', diffPixels, ratio, diff: PNG.sync.write(diff) };
}

export interface SnapshotOptions extends CompareOptions {
  /** Папка со снимками. По умолчанию `reference/snapshots`. */
  snapshotDir?: string;
  /** Папка для отличающихся кадров. По умолчанию `reference/test/__diff__`. */
  diffDir?: string;
}

export type SnapshotResult =
  | { status: 'written'; path: string }
  | { status: 'match'; diffPixels: number; ratio: number }
  | { status: 'mismatch'; diffPixels: number; ratio: number; actualPath: string; diffPath: string }
  | { status: 'size-mismatch'; expected: Size; actual: Size; actualPath: string };

/** Включён ли режим обновления снимков. В CI он запрещён, чтобы прогон не стал зелёным сам собой. */
export function isUpdatingSnapshots(): boolean {
  const update = process.env.UPDATE_SNAPSHOTS === '1';
  if (update && process.env.CI) {
    throw new Error('UPDATE_SNAPSHOTS=1 нельзя использовать в CI.');
  }
  return update;
}

/**
 * Сравнивает PNG со снимком `<snapshotDir>/<name>.png`.
 *
 * Снимок записывается только в режиме `UPDATE_SNAPSHOTS=1`. Если снимка нет, функция
 * бросает ошибку. При расхождении фактический кадр и карта отличий сохраняются
 * в `diffDir`, а при совпадении старые файлы отличий этого снимка удаляются.
 */
export function matchSnapshot(
  name: string,
  png: Buffer,
  options: SnapshotOptions = {},
): SnapshotResult {
  const dir = options.snapshotDir ?? snapshotDir;
  const diffs = options.diffDir ?? diffDir;
  const path = join(dir, `${name}.png`);
  const actualPath = join(diffs, `${name}.actual.png`);
  const diffPath = join(diffs, `${name}.diff.png`);
  rmSync(actualPath, { force: true });
  rmSync(diffPath, { force: true });

  if (isUpdatingSnapshots()) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, png);
    return { status: 'written', path };
  }
  if (!existsSync(path)) {
    throw new Error(`Нет снимка ${path}. Создайте его командой pnpm snapshots:update.`);
  }

  const result = compareImages(readFileSync(path), png, options);
  if (result.status === 'match') {
    return result;
  }
  mkdirSync(diffs, { recursive: true });
  writeFileSync(actualPath, png);
  if (result.status === 'size-mismatch') {
    return { ...result, actualPath };
  }
  writeFileSync(diffPath, result.diff);
  return {
    status: 'mismatch',
    diffPixels: result.diffPixels,
    ratio: result.ratio,
    actualPath,
    diffPath,
  };
}
