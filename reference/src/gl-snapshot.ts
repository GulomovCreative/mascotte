// Commands for the WebGL browser tests: they run in Node. Do not import into browser code.
import { join } from 'node:path';
import type { BrowserCommand } from 'vitest/node';
import { diffDir, matchSnapshot, type SnapshotResult, snapshotDir } from './snapshot.ts';

/** WebGL snapshot folder: WebGL and Canvas 2D frames differ in antialiasing and overlaps. */
export const glSnapshotDir = join(snapshotDir, 'gl');
export const glDiffDir = join(diffDir, 'gl');

/**
 * Compares a frame from the browser (a PNG data URL) with the snapshot `reference/snapshots/gl/<name>.png`.
 * As with other snapshots, it is updated only in `UPDATE_SNAPSHOTS=1` mode.
 */
export const matchGLSnapshot: BrowserCommand<[name: string, dataUrl: string]> = (
  _context,
  name,
  dataUrl,
): SnapshotResult => {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`Expected a PNG data URL for snapshot ${name}.`);
  }
  const png = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  // SwiftShader is deterministic: a rerun on the same Chromium version (set by playwright
  // in pnpm-lock.yaml) gives the same frame. A Chromium update may shift edge antialiasing;
  // then the snapshots are regenerated. The 0.05% tolerance covers small differences; missing
  // mascot pupils differed by 0.19% of the frame.
  return matchSnapshot(name, png, {
    snapshotDir: glSnapshotDir,
    diffDir: glDiffDir,
    maxDiffRatio: 0.0005,
    updateCommand: 'pnpm snapshots:update:gl',
  });
};

export const glCommands = { matchGLSnapshot };
