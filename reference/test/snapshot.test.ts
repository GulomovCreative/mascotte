import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareImages, isUpdatingSnapshots, matchSnapshot } from '../src/snapshot.ts';

/** PNG заданного размера, залитый одним цветом; `changed` первых пикселей перекрашены. */
function makePng(width: number, height: number, changed = 0): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const value = i < changed ? 0 : 255;
    png.data.set([value, value, value, 255], i * 4);
  }
  return PNG.sync.write(png);
}

let dir: string;
let options: { snapshotDir: string; diffDir: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mascotte-snapshot-'));
  options = { snapshotDir: join(dir, 'snapshots'), diffDir: join(dir, 'diff') };
  vi.stubEnv('CI', '');
  vi.stubEnv('UPDATE_SNAPSHOTS', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function writeSnapshot(name: string, png: Buffer): void {
  vi.stubEnv('UPDATE_SNAPSHOTS', '1');
  matchSnapshot(name, png, options);
  vi.stubEnv('UPDATE_SNAPSHOTS', '');
}

describe('compareImages', () => {
  it('одинаковые кадры совпадают', () => {
    expect(compareImages(makePng(10, 10), makePng(10, 10))).toMatchObject({
      status: 'match',
      diffPixels: 0,
    });
  });

  it('отличие в пределах допуска считается совпадением', () => {
    const result = compareImages(makePng(10, 10), makePng(10, 10, 1), { maxDiffRatio: 0.02 });
    expect(result).toMatchObject({ status: 'match', diffPixels: 1, ratio: 0.01 });
  });

  it('отличие сверх допуска даёт расхождение', () => {
    const result = compareImages(makePng(10, 10), makePng(10, 10, 5), { maxDiffRatio: 0.02 });
    expect(result).toMatchObject({ status: 'mismatch', diffPixels: 5, ratio: 0.05 });
  });

  it('разный размер даёт size-mismatch', () => {
    expect(compareImages(makePng(10, 10), makePng(12, 10))).toEqual({
      status: 'size-mismatch',
      expected: { width: 10, height: 10 },
      actual: { width: 12, height: 10 },
    });
  });
});

describe('matchSnapshot', () => {
  it('без снимка бросает ошибку и ничего не пишет', () => {
    expect(() => matchSnapshot('a', makePng(4, 4), options)).toThrow(/Нет снимка/);
    expect(existsSync(join(options.snapshotDir, 'a.png'))).toBe(false);
  });

  it('в режиме обновления перезаписывает снимок', () => {
    writeSnapshot('a', makePng(4, 4));
    vi.stubEnv('UPDATE_SNAPSHOTS', '1');
    const next = makePng(4, 4, 3);
    expect(matchSnapshot('a', next, options).status).toBe('written');
    expect(readFileSync(join(options.snapshotDir, 'a.png')).equals(next)).toBe(true);
  });

  it('в CI режим обновления запрещён', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('UPDATE_SNAPSHOTS', '1');
    expect(() => isUpdatingSnapshots()).toThrow(/CI/);
    expect(() => matchSnapshot('a', makePng(4, 4), options)).toThrow(/CI/);
  });

  it('при расхождении сохраняет кадр и карту отличий', () => {
    writeSnapshot('a', makePng(10, 10));
    const result = matchSnapshot('a', makePng(10, 10, 50), options);
    expect(result).toMatchObject({ status: 'mismatch', diffPixels: 50 });
    if (result.status !== 'mismatch') return;
    expect(existsSync(result.actualPath)).toBe(true);
    expect(existsSync(result.diffPath)).toBe(true);
  });

  it('при разном размере сохраняет фактический кадр', () => {
    writeSnapshot('a', makePng(10, 10));
    const result = matchSnapshot('a', makePng(8, 8), options);
    expect(result.status).toBe('size-mismatch');
    if (result.status !== 'size-mismatch') return;
    expect(existsSync(result.actualPath)).toBe(true);
  });

  it('при совпадении удаляет старые файлы отличий', () => {
    writeSnapshot('a', makePng(10, 10));
    const failed = matchSnapshot('a', makePng(10, 10, 50), options);
    expect(failed.status).toBe('mismatch');
    expect(matchSnapshot('a', makePng(10, 10), options).status).toBe('match');
    expect(existsSync(join(options.diffDir, 'a.actual.png'))).toBe(false);
    expect(existsSync(join(options.diffDir, 'a.diff.png'))).toBe(false);
  });
});
