// Снимки кадров для тестов в Node. Не импортировать в браузерный код.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { type Context2D, type ReferenceScene, type RenderOptions, renderScene } from './scene.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const snapshotDir = join(root, 'snapshots');
export const diffDir = join(root, 'test', '__diff__');

/** Рисует сцену в canvas Node и возвращает PNG. */
export function renderSceneToPng(scene: ReferenceScene, options: RenderOptions = {}): Buffer {
  const pixelRatio = options.pixelRatio ?? 1;
  const canvas = createCanvas(scene.width * pixelRatio, scene.height * pixelRatio);
  const ctx = canvas.getContext('2d');
  renderScene(scene, scene.build(), ctx as unknown as Context2D, options);
  return canvas.toBuffer('image/png');
}

export interface SnapshotOptions {
  /** Чувствительность сравнения цвета пикселя, от 0 до 1 (параметр pixelmatch). */
  threshold?: number;
  /** Допустимая доля отличающихся пикселей. */
  maxDiffRatio?: number;
}

export type SnapshotResult =
  | { status: 'written'; path: string }
  | { status: 'match'; diffPixels: number }
  | { status: 'mismatch'; diffPixels: number; ratio: number; diffPath: string }
  | { status: 'size-mismatch'; expected: string; actual: string };

/**
 * Сравнивает PNG со снимком `snapshots/<name>.png`. Снимок записывается, если его нет
 * или задана переменная `UPDATE_SNAPSHOTS=1`. В CI отсутствующий снимок не создаётся.
 */
export function matchSnapshot(
  name: string,
  png: Buffer,
  { threshold = 0.1, maxDiffRatio = 0.001 }: SnapshotOptions = {},
): SnapshotResult {
  const path = join(snapshotDir, `${name}.png`);
  const update = process.env.UPDATE_SNAPSHOTS === '1';
  if (update || (!existsSync(path) && !process.env.CI)) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(path, png);
    return { status: 'written', path };
  }
  if (!existsSync(path)) {
    throw new Error(`Нет снимка ${path}. Создайте его командой pnpm snapshots:update.`);
  }

  const expected = PNG.sync.read(readFileSync(path));
  const actual = PNG.sync.read(png);
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      status: 'size-mismatch',
      expected: `${expected.width}×${expected.height}`,
      actual: `${actual.width}×${actual.height}`,
    };
  }

  const { width, height } = expected;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(expected.data, actual.data, diff.data, width, height, {
    threshold,
  });
  const ratio = diffPixels / (width * height);
  if (ratio <= maxDiffRatio) {
    return { status: 'match', diffPixels };
  }

  mkdirSync(diffDir, { recursive: true });
  writeFileSync(join(diffDir, `${name}.actual.png`), png);
  const diffPath = join(diffDir, `${name}.diff.png`);
  writeFileSync(diffPath, PNG.sync.write(diff));
  return { status: 'mismatch', diffPixels, ratio, diffPath };
}
