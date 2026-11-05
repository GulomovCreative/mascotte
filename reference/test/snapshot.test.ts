import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareImages, isUpdatingSnapshots, matchSnapshot } from '../src/snapshot.ts';

/** A PNG of the given size filled with one color; the first `changed` pixels are recolored. */
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
  it('identical frames match', () => {
    expect(compareImages(makePng(10, 10), makePng(10, 10))).toMatchObject({
      status: 'match',
      diffPixels: 0,
    });
  });

  it('a difference within tolerance counts as a match', () => {
    const result = compareImages(makePng(10, 10), makePng(10, 10, 1), { maxDiffRatio: 0.02 });
    expect(result).toMatchObject({ status: 'match', diffPixels: 1, ratio: 0.01 });
  });

  it('a difference beyond tolerance is a mismatch', () => {
    const result = compareImages(makePng(10, 10), makePng(10, 10, 5), { maxDiffRatio: 0.02 });
    expect(result).toMatchObject({ status: 'mismatch', diffPixels: 5, ratio: 0.05 });
  });

  it('a different size gives size-mismatch', () => {
    expect(compareImages(makePng(10, 10), makePng(12, 10))).toEqual({
      status: 'size-mismatch',
      expected: { width: 10, height: 10 },
      actual: { width: 12, height: 10 },
    });
  });
});

describe('matchSnapshot', () => {
  it('throws without a snapshot and writes nothing', () => {
    expect(() => matchSnapshot('a', makePng(4, 4), options)).toThrow(/No snapshot/);
    expect(existsSync(join(options.snapshotDir, 'a.png'))).toBe(false);
  });

  it('overwrites the snapshot in update mode', () => {
    writeSnapshot('a', makePng(4, 4));
    vi.stubEnv('UPDATE_SNAPSHOTS', '1');
    const next = makePng(4, 4, 3);
    expect(matchSnapshot('a', next, options).status).toBe('written');
    expect(readFileSync(join(options.snapshotDir, 'a.png')).equals(next)).toBe(true);
  });

  it('update mode is forbidden in CI', () => {
    vi.stubEnv('CI', 'true');
    vi.stubEnv('UPDATE_SNAPSHOTS', '1');
    expect(() => isUpdatingSnapshots()).toThrow(/CI/);
    expect(() => matchSnapshot('a', makePng(4, 4), options)).toThrow(/CI/);
  });

  it('on mismatch saves the frame and the diff map', () => {
    writeSnapshot('a', makePng(10, 10));
    const result = matchSnapshot('a', makePng(10, 10, 50), options);
    expect(result).toMatchObject({ status: 'mismatch', diffPixels: 50 });
    if (result.status !== 'mismatch') return;
    expect(existsSync(result.actualPath)).toBe(true);
    expect(existsSync(result.diffPath)).toBe(true);
  });

  it('on size mismatch saves the actual frame', () => {
    writeSnapshot('a', makePng(10, 10));
    const result = matchSnapshot('a', makePng(8, 8), options);
    expect(result.status).toBe('size-mismatch');
    if (result.status !== 'size-mismatch') return;
    expect(existsSync(result.actualPath)).toBe(true);
  });

  it('on match removes old diff files', () => {
    writeSnapshot('a', makePng(10, 10));
    const failed = matchSnapshot('a', makePng(10, 10, 50), options);
    expect(failed.status).toBe('mismatch');
    expect(matchSnapshot('a', makePng(10, 10), options).status).toBe('match');
    expect(existsSync(join(options.diffDir, 'a.actual.png'))).toBe(false);
    expect(existsSync(join(options.diffDir, 'a.diff.png'))).toBe(false);
  });
});
