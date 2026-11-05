// Frame snapshots for tests in Node. Do not import into browser code.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Camera, CanvasRenderer, Scene } from '@mascotte/engine';
import { createCanvas } from '@napi-rs/canvas';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { EngineScene } from './engine-only/scenes.ts';
import type { ReferenceScene, RenderOptions } from './scene.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const snapshotDir = join(root, 'snapshots');
export const diffDir = join(root, 'test', '__diff__');
/**
 * Snapshots drawn by the Zdog copy before its removal: frozen ground truth for the reference
 * scenes.
 */
export const zdogSnapshotDir = join(snapshotDir, 'zdog');

/**
 * Draws a reference scene with the new engine on a Node canvas and returns a PNG of size
 * `width × height` multiplied by `pixelRatio` (for Zdog snapshots: 2 for the main frame,
 * 1 for animation frames). By default the graph is built anew, but an already built scene
 * can be passed to draw one graph several times.
 */
export function renderEngineToPng(
  scene: ReferenceScene,
  options: RenderOptions = {},
  world: Scene = new Scene(scene.engine.build()),
): Buffer {
  const pixelRatio = options.pixelRatio ?? 1;
  const canvas = createCanvas(scene.width * pixelRatio, scene.height * pixelRatio);
  scene.engine.pose(world.root, options.time ?? 0);
  // The Zdog snapshots were drawn without partial occlusion, so it is off here.
  new CanvasRenderer({ partialOcclusion: false }).render(
    canvas.getContext('2d'),
    world,
    new Camera({ zoom: scene.zoom }),
    {
      width: scene.width,
      height: scene.height,
      pixelRatio,
      background: scene.background,
    },
  );
  return canvas.toBuffer('image/png');
}

/** Draws a new-engine-only scene on a Node canvas and returns a PNG. */
export function renderEngineSceneToPng(scene: EngineScene, options: RenderOptions = {}): Buffer {
  const pixelRatio = options.pixelRatio ?? 1;
  const canvas = createCanvas(scene.width * pixelRatio, scene.height * pixelRatio);
  const { root, camera } = scene.build();
  scene.pose(root, camera, options.time ?? 0);
  new CanvasRenderer().render(canvas.getContext('2d'), new Scene(root), camera, {
    width: scene.width,
    height: scene.height,
    pixelRatio,
    background: scene.background,
  });
  return canvas.toBuffer('image/png');
}

export interface CompareOptions {
  /** Pixel color comparison sensitivity, from 0 to 1 (the pixelmatch threshold). */
  threshold?: number;
  /** Allowed fraction of differing pixels. */
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

/** Compares two PNGs without writing anything to disk. */
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
  /** Snapshot folder. Defaults to `reference/snapshots`. */
  snapshotDir?: string;
  /** Folder for differing frames. Defaults to `reference/test/__diff__`. */
  diffDir?: string;
  /**
   * The command that creates snapshots, for the error message. Defaults to `pnpm snapshots:update`.
   */
  updateCommand?: string;
}

export type SnapshotResult =
  | { status: 'written'; path: string }
  | { status: 'match'; diffPixels: number; ratio: number }
  | { status: 'mismatch'; diffPixels: number; ratio: number; actualPath: string; diffPath: string }
  | { status: 'size-mismatch'; expected: Size; actual: Size; actualPath: string };

/**
 * Whether snapshot update mode is on. It is forbidden in CI so a run cannot turn green by itself.
 */
export function isUpdatingSnapshots(): boolean {
  const update = process.env.UPDATE_SNAPSHOTS === '1';
  if (update && process.env.CI) {
    throw new Error('UPDATE_SNAPSHOTS=1 cannot be used in CI.');
  }
  return update;
}

/**
 * Compares a PNG with the snapshot `<snapshotDir>/<name>.png`.
 *
 * The snapshot is written only in `UPDATE_SNAPSHOTS=1` mode. If there is no snapshot, the
 * function throws. On mismatch the actual frame and the diff map are saved to `diffDir`;
 * on match the old diff files for this snapshot are removed.
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
    const command = options.updateCommand ?? 'pnpm snapshots:update';
    throw new Error(`No snapshot ${path}. Create it with ${command}.`);
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
